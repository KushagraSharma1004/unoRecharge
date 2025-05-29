const express = require('express');
const cors = require('cors');
const crypto = require('crypto'); // Already imported
const { Cashfree } = require('cashfree-pg');
require('dotenv').config();
const cron = require('node-cron');
const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  getDocs,
  writeBatch,
  serverTimestamp,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  runTransaction
} = require('firebase/firestore');

const app = express();
app.use(cors());

// IMPORTANT: Configure Express to parse raw body for webhook signature verification
// This must come BEFORE app.use(express.json()) if you use it globally
app.use(express.json({
  limit: '5mb', // Adjust limit as needed
  verify: (req, res, buf) => {
    // Store the raw body on the request object
    req.rawBody = buf.toString();
  }
}));

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const CASHFREE_WEBHOOK_SECRET = process.env.CASHFREE_WEBHOOK_SECRET;

const performDeduction = async () => {
  try {
    console.log('Starting balance deduction process...', new Date().toISOString());
    const usersCol = collection(db, 'users');
    const usersSnapshot = await getDocs(usersCol);
    const deductionAmount = 12;

    if (usersSnapshot.empty) {
      console.log('No users found to process.', new Date().toISOString());
      return;
    }

    const batch = writeBatch(db);
    let processedCount = 0;

    usersSnapshot.forEach((userDoc) => {
      const userData = userDoc.data();
      const currentBalance = userData.balance || 0;

      if (currentBalance >= deductionAmount) {
        const newBalance = currentBalance - deductionAmount;
        batch.update(userDoc.ref, {
          balance: newBalance,
          lastDeduction: serverTimestamp()
        });

        const deductionsCol = collection(db, `users/${userDoc.id}/deductions`);
        const deductionRef = doc(deductionsCol);
        batch.set(deductionRef, {
          amount: deductionAmount,
          previousBalance: currentBalance,
          newBalance: newBalance,
          timestamp: serverTimestamp(),
          type: 'daily_charge'
        });
        processedCount++;
      }
    });

    if (processedCount > 0) {
      await batch.commit();
      console.log(`✅ Success: Deducted ₹${deductionAmount} from ${processedCount} users.`, new Date().toISOString());
    } else {
      console.log('No users had sufficient balance for deduction.', new Date().toISOString());
    }
  } catch (error) {
    console.error('❌ Deduction failed:', error, new Date().toISOString());
  }
};

cron.schedule('0 0 * * *', performDeduction, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});

console.log('Scheduler is active. Daily deduction will run at midnight (Asia/Kolkata time).');

Cashfree.XClientId = process.env.CLIENT_ID;
Cashfree.XClientSecret = process.env.CLIENT_SECRET;
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION; // Ensure this is correct for your setup

const processSuccessfulRecharge = async (orderId, mobileNumber) => {
  try {
    await runTransaction(db, async (transaction) => {
      const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
      const orderSnap = await transaction.get(orderRef);

      if (!orderSnap.exists()) {
        console.log(`Order not found in Firestore for orderId: ${orderId} during transaction.`);
        throw new Error(`Order not found in Firestore for orderId: ${orderId}`);
      }

      const orderData = orderSnap.data();
      const rechargeAmount = Number(orderData.amount) || 0;
      const plan = orderData.plan;

      const rechargeDocRef = doc(db, `users/${mobileNumber}/recharges/${orderId}`);
      transaction.set(rechargeDocRef, {
        timestamp: serverTimestamp(),
        plan: plan,
        amount: rechargeAmount,
        rechargeId: orderId,
      });
      console.log("Attempted to set recharge record at path: "+rechargeDocRef.path);

      const userRef = doc(db, `users/${mobileNumber}`);
      const userSnap = await transaction.get(userRef);
      const userData = userSnap.data();
      const currentBalance = Number(userData.balance) || 0;

      let newBalance = currentBalance + rechargeAmount;
      if (plan === 'yearly') {
        newBalance += 720;
      }

      transaction.update(userRef, {
        balance: newBalance,
        lastRecharge: serverTimestamp()
      });

      transaction.delete(orderRef);

      console.log(`✅ Recharge processed successfully for user ${mobileNumber}, Order ID: ${orderId}. New balance: ${newBalance}`);
    });
    return { success: true, message: 'Recharge successfully processed.' };
  } catch (error) {
    console.error(`❌ Error processing recharge for order ID ${orderId}:`, error);
    return { success: false, message: `Failed to process recharge: ${error.message}` };
  }
};

// Create payment order endpoint
app.post('/create-order', async (req, res) => {
  try {
    const { plan, amount, planDetails, mobileNumber, shopName, orderId } = req.body;

    if (!plan || !amount || !planDetails || !mobileNumber || !shopName || !orderId) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
    await setDoc(orderRef, {
      plan: plan,
      amount: amount,
      timestamp: serverTimestamp(),
      status: 'initiated',
      mobileNumber: mobileNumber,
      shopName: shopName
    });
    console.log(`Order ${orderId} details saved to Firestore for user ${mobileNumber}.`);

    const request = {
      order_amount: amount,
      order_currency: "INR",
      order_id: orderId,
      customer_details: {
        customer_id: shopName,
        customer_phone: mobileNumber
      },
      order_meta: {
        // You can still provide a return_url for client-side redirection after payment
        // but the actual update should happen via webhook.
        return_url: `https://unoshops.com`, // Or a specific success/failure page
        plan_details: planDetails
      }
    };

    const response = await Cashfree.PGCreateOrder("2023-08-01", request);
    res.json(response.data);
  } catch (error) {
    console.error("Order creation error:", error);
    if (req.body.orderId && req.body.mobileNumber) {
      const orderRef = doc(db, `users/${req.body.mobileNumber}/rechargesOrderIds/${req.body.orderId}`);
      await deleteDoc(orderRef).catch(e => console.error("Error deleting failed order from Firestore:", e));
      console.log(`Cleaned up initiated order ${req.body.orderId} due to Cashfree order creation failure.`);
    }
    res.status(500).json({
      error: error.response?.data?.message || "Failed to create order"
    });
  }
});


// ... (rest of your code remains the same until the webhook endpoint) ...

app.post('/webhook', async (req, res) => {
  console.log('--- Cashfree Webhook received ---', new Date().toISOString());

  const xWebhookTimestamp = req.headers['x-webhook-timestamp'];
  const xWebhookSignature = req.headers['x-webhook-signature'];
  const xWebhookVersion = req.headers['x-webhook-version'];
  const rawBody = req.rawBody;

  console.log('Webhook Headers:', { xWebhookTimestamp, xWebhookSignature, xWebhookVersion });
  console.log('Webhook Raw Body:', rawBody);

  if (!xWebhookTimestamp || !xWebhookSignature || !rawBody) {
    console.error('Webhook: Missing required headers or raw body for signature verification.');
    return res.status(400).send('Bad Request: Missing required webhook data.');
  }

  try {
    // Pass the dedicated webhook secret here if it's different from CLIENT_SECRET
    const isSignatureValid = Cashfree.PGVerifyWebhookSignature(
      xWebhookSignature,
      xWebhookTimestamp,
      rawBody,
      CASHFREE_WEBHOOK_SECRET // <--- ADD THIS LINE IF IT'S A DEDICATED WEBHOOK SECRET
    );

    if (!isSignatureValid) {
      console.error('Webhook: Invalid signature. Request might be fraudulent.');
      return res.status(401).send('Unauthorized: Invalid webhook signature.');
    }

    console.log('Webhook signature successfully verified.');

    // 3. Process the webhook payload
    const webhookData = req.body; // req.body is now the parsed JSON from express.json()
    console.log('Parsed Webhook Data:', webhookData);

    const eventType = webhookData.event;
    const orderDetails = webhookData.data.order;
    const paymentDetails = webhookData.data.payment;

    const orderId = orderDetails.order_id;
    const mobileNumber = orderDetails.customer_details ? orderDetails.customer_details.customer_phone : null; // Get mobile from order_meta if stored there, or customer_details

    if (!orderId || !mobileNumber) {
      console.error('Webhook: Could not extract orderId or mobileNumber from webhook payload.', webhookData);
      return res.status(400).send('Bad Request: Invalid webhook payload structure.');
    }

    if (eventType === 'PAYMENT_SUCCESS') {
      console.log(`Webhook: Payment success for Order ID: ${orderId}, Mobile: ${mobileNumber}`);
      const result = await processSuccessfulRecharge(orderId, mobileNumber);
      if (result.success) {
        return res.status(200).send('Webhook processed successfully.');
      } else {
        console.error(`Webhook: Failed to process successful recharge for Order ID ${orderId}: ${result.message}`);
        // Return 200 OK even on internal processing failure to avoid constant retries from Cashfree.
        // You should have robust internal error logging and monitoring for these cases.
        return res.status(200).send('Webhook received, but internal processing failed.');
      }
    } else if (eventType === 'PAYMENT_FAILED' || eventType === 'PAYMENT_USER_DROPPED') {
      console.log(`Webhook: Payment ${eventType} for Order ID: ${orderId}, Mobile: ${mobileNumber}`);
      // Optionally update the status of the temporary order in Firestore to 'FAILED'
      const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
      await setDoc(orderRef, { status: eventType, timestamp: serverTimestamp() }, { merge: true })
        .catch(e => console.error(`Error updating status for failed order ${orderId}:`, e));
      return res.status(200).send('Webhook received and order status updated.');
    } else {
      console.log(`Webhook: Unhandled event type: ${eventType}`);
      return res.status(200).send('Webhook received, event type not handled.');
    }

  } catch (error) {
    console.error("Webhook processing error:", error);
    res.status(200).send('Webhook received, but encountered an error during processing.');
  }
});

// Remove the old /verify endpoint if you are purely relying on webhooks.
// If you still want to allow manual verification, keep it, but ensure your client uses it explicitly.
// For now, I'll keep it commented out to emphasize the webhook approach.
/*
app.post('/verify', async (req, res) => {
  console.log('--- /verify endpoint hit ---', new Date().toISOString());
  console.log('Request body:', req.body);

  try {
    const { orderId, mobileNumber } = req.body;
    if (!orderId || !mobileNumber) {
      console.error('Error: Order ID or Mobile Number missing in /verify request.', req.body);
      return res.status(400).json({ error: "Order ID and Mobile Number are required" });
    }

    const response = await Cashfree.PGOrderFetchPayments("2023-08-01", orderId);
    const cashfreePaymentStatus = response.data.order_status;

    console.log(`Cashfree status for Order ID ${orderId}: ${cashfreePaymentStatus}`);

    if (cashfreePaymentStatus === 'PAID') {
      const result = await processSuccessfulRecharge(orderId, mobileNumber);
      if (result.success) {
        return res.status(200).json({
          message: "Payment verified and balance updated.",
          cashfreeStatus: cashfreePaymentStatus,
          data: response.data
        });
      } else {
        return res.status(500).json({
          message: result.message,
          cashfreeStatus: cashfreePaymentStatus,
          data: response.data
        });
      }
    } else {
      const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
      await setDoc(orderRef, { status: cashfreePaymentStatus, timestamp: serverTimestamp() }, { merge: true });

      if (cashfreePaymentStatus === 'FAILED') {
        console.log(`Order ${orderId} marked as FAILED in Firestore.`);
      }

      return res.status(200).json({
        message: "Payment not successful or pending.",
        cashfreeStatus: cashfreePaymentStatus,
        data: response.data
      });
    }
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({
      error: error.response?.data?.message || "Failed to verify payment",
      details: error.message
    });
  }
});
*/

// Manual trigger endpoint
app.post('/trigger-deduction', async (req, res) => {
  console.log('Manually triggering deduction...');
  try {
    await performDeduction();
    res.status(200).json({ success: true, message: 'Deduction process finished successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Deduction process failed.', error: error.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
