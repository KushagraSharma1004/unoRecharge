const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
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

// Ensure the secret is loaded and trimmed here, as you added previously
const CASHFREE_WEBHOOK_SECRET = process.env.CASHFREE_WEBHOOK_SECRET ? process.env.CASHFREE_WEBHOOK_SECRET.trim() : undefined;

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


app.post('/webhook', async (req, res) => {
  console.log('--- Cashfree Webhook received ---', new Date().toISOString());

  const xWebhookTimestamp = req.headers['x-webhook-timestamp'];
  const xWebhookSignature = req.headers['x-webhook-signature'];
  const xWebhookVersion = req.headers['x-webhook-version'];
  const rawBody = req.rawBody; // Already captured by middleware

  console.log('Webhook Headers:', { xWebhookTimestamp, xWebhookSignature, xWebhookVersion });
  console.log('Webhook Raw Body (length: ' + rawBody.length + '): ' + rawBody); // Log length for debug

  if (!xWebhookTimestamp || !xWebhookSignature || !rawBody) {
    console.error('Webhook: Missing required headers or raw body for signature verification.');
    return res.status(400).send('Bad Request: Missing required webhook data.');
  }

  // Ensure the secret is loaded and trimmed
  if (!CASHFREE_WEBHOOK_SECRET) {
    console.error('Webhook: CASHFREE_WEBHOOK_SECRET is not set or empty.');
    return res.status(500).send('Server Error: Webhook secret not configured.');
  }
  console.log(`DEBUG: CASHFREE_WEBHOOK_SECRET length: ${CASHFREE_WEBHOOK_SECRET.length}`);
  console.log(`DEBUG: CASHFREE_WEBHOOK_SECRET value: "${CASHFREE_WEBHOOK_SECRET}"`); // Log secret for debug (BE CAREFUL IN PROD)


  try {
    // --- MANUAL SIGNATURE VERIFICATION (as per Cashfree Support) ---
    const dataToSign = xWebhookTimestamp + rawBody;
    const hmac = crypto.createHmac('sha256', CASHFREE_WEBHOOK_SECRET); // Use your loaded secret
    hmac.update(dataToSign);
    const generatedSignature = hmac.digest('base64'); // Cashfree uses base64 encoding

    console.log(`Data to Sign (first 100 chars): "${dataToSign.substring(0, 100)}..."`);
    console.log(`Generated Signature (manual): "${generatedSignature}"`);
    console.log(`Received Signature: "${xWebhookSignature}"`);

    const isSignatureValid = (generatedSignature === xWebhookSignature);
    // --- END MANUAL SIGNATURE VERIFICATION ---

    if (!isSignatureValid) {
      console.error('Webhook: Invalid signature. Generated and received signatures did not match (manual check).');
      return res.status(401).send('Unauthorized: Invalid webhook signature.');
    }

    console.log('Webhook signature successfully verified (manual check).');

    // 3. Process the webhook payload
    const webhookData = req.body; // req.body is now the parsed JSON from express.json()
    console.log('Parsed Webhook Data:', webhookData);

    const eventType = webhookData.event;
    const orderDetails = webhookData.data.order;
    const paymentDetails = webhookData.data.payment;

    const orderId = orderDetails.order_id;
    // Get mobile number from customer_details as it is present in the payload
    const mobileNumber = orderDetails.customer_details ? orderDetails.customer_details.customer_phone : null;

    if (!orderId || !mobileNumber) {
      console.error('Webhook: Could not extract orderId or mobileNumber from webhook payload.', webhookData);
      return res.status(400).send('Bad Request: Invalid webhook payload structure.');
    }

    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK') { // Ensure correct event type for real webhook
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
    } else if (eventType === 'PAYMENT_FAILED_WEBHOOK' || eventType === 'PAYMENT_USER_DROPPED_WEBHOOK') {
        // Updated event types to match actual webhook payload
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
