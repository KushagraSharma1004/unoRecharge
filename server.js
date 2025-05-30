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
  runTransaction,
  query, // Import query
  where // Import where
} = require('firebase/firestore');

const app = express();
app.use(cors());

app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
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
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION;

const processSuccessfulRecharge = async (orderId, mobileNumber) => {
  try {
    await runTransaction(db, async (transaction) => {
      const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
      const orderSnap = await transaction.get(orderRef);

      if (!orderSnap.exists()) {
        console.log(`Order not found in Firestore for orderId: ${orderId} during transaction.`);
        const existingRechargeRef = doc(db, `users/${mobileNumber}/recharges/${orderId}`);
        const existingRechargeSnap = await transaction.get(existingRechargeRef);
        if (existingRechargeSnap.exists()) {
            console.log(`Order ${orderId} already processed for user ${mobileNumber}. Skipping.`);
            return { success: true, message: 'Order already processed.' };
        }
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
        status: 'SUCCESS'
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

// Create payment order endpoint - Return URL is less critical for server-side polling
app.post('/create-order', async (req, res) => {
  try {
    const { plan, amount, planDetails, mobileNumber, shopName, orderId } = req.body;

    if (!plan || !amount || !planDetails || !mobileNumber || !shopName || !orderId) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Store the order details with a 'pending' status
    const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
    await setDoc(orderRef, {
      plan: plan,
      amount: amount,
      timestamp: serverTimestamp(),
      status: 'initiated', // Mark as initiated, needs verification
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
        // You still need a return_url for Cashfree, but its target won't directly trigger your backend logic.
        // It could just lead to a generic "payment in progress" or "check status later" page.
        return_url: `https://your-frontend-domain.com/payment-status?order_id=${orderId}`,
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

// REMOVED: The /verify-payment-status endpoint as it relies on frontend to trigger.
// This logic will now be handled by the cron job for server-side polling.
// app.post('/verify-payment-status', async (req, res) => { ... });

// --- NEW CRON JOB FOR SERVER-SIDE POLLING ---
const pollCashfreePayments = async () => {
  console.log('--- Starting Cashfree Payment Polling ---', new Date().toISOString());
  try {
    // 1. Find all users
    const usersSnapshot = await getDocs(collection(db, 'users'));
    if (usersSnapshot.empty) {
      console.log('No users found for polling.');
      return;
    }

    let ordersChecked = 0;
    let successfulRecharges = 0;
    let failedRecharges = 0;

    for (const userDoc of usersSnapshot.docs) {
      const mobileNumber = userDoc.id; // Assuming user ID is the mobile number

      // 2. For each user, get pending orders from 'rechargesOrderIds'
      // We look for orders that are 'initiated' or 'pending' for a certain period
      // For simplicity, we'll just check all existing ones, but in a real app,
      // you might add a `timestamp` and only check orders older than a few minutes/hours
      const pendingOrdersSnapshot = await getDocs(collection(db, `users/${mobileNumber}/rechargesOrderIds`));

      if (pendingOrdersSnapshot.empty) {
        continue;
      }

      for (const orderDoc of pendingOrdersSnapshot.docs) {
        const orderId = orderDoc.id;
        const currentStatusInDB = orderDoc.data().status;

        // Skip orders that are already processed or failed in our system, unless re-checking
        if (currentStatusInDB === 'SUCCESS' || currentStatusInDB === 'FAILED' || currentStatusInDB === 'USER_DROPPED') {
            console.log(`Skipping polling for order ${orderId} (user ${mobileNumber}) as its status in DB is already ${currentStatusInDB}.`);
            continue;
        }

        console.log(`Polling Cashfree for Order ID: ${orderId} (User: ${mobileNumber})`);
        ordersChecked++;

        try {
          const cfResponse = await Cashfree.PGVerifyPayment("2023-08-01", { order_id: orderId });
          const paymentStatus = cfResponse.data.payment_status;

          console.log(`Cashfree status for Order ID ${orderId}: ${paymentStatus}`);

          if (paymentStatus === 'SUCCESS') {
            console.log(`Payment SUCCESS detected for Order ID ${orderId}. Processing recharge...`);
            const result = await processSuccessfulRecharge(orderId, mobileNumber);
            if (result.success) {
              successfulRecharges++;
            } else {
              console.error(`Polling: Failed to process successful recharge for Order ID ${orderId}: ${result.message}`);
              // Even if processing failed, Cashfree confirmed success, so mark it
              // to prevent re-processing in a loop. A human needs to intervene.
              const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
              await setDoc(orderRef, { status: 'SUCCESS_INTERNAL_FAILURE', timestamp: serverTimestamp() }, { merge: true });
            }
          } else if (paymentStatus === 'FAILED' || paymentStatus === 'USER_DROPPED') {
            console.log(`Payment ${paymentStatus} detected for Order ID ${orderId}. Updating status in DB.`);
            failedRecharges++;
            const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
            // Update status in temporary collection and optionally delete it
            await setDoc(orderRef, { status: paymentStatus, timestamp: serverTimestamp() }, { merge: true });
            // Optionally delete the orderRef here if you don't need failed records
            // await deleteDoc(orderRef);
          } else if (paymentStatus === 'PENDING') {
              console.log(`Order ${orderId} is still PENDING with Cashfree.`);
              // Keep it in rechargesOrderIds with 'initiated' or 'pending' status
              // No action needed other than logging.
              const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
              await setDoc(orderRef, { status: 'PENDING', timestamp: serverTimestamp() }, { merge: true });
          } else {
            console.log(`Unhandled Cashfree status for Order ID ${orderId}: ${paymentStatus}`);
            // You might want to update status to 'UNKNOWN' or similar for manual review
            const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
            await setDoc(orderRef, { status: `CF_${paymentStatus}`, timestamp: serverTimestamp() }, { merge: true });
          }
        } catch (pollError) {
          console.error(`❌ Error during Cashfree polling for order ID ${orderId}:`, pollError.response?.data || pollError.message);
          // Log the error but continue with other orders
        }
      }
    }
    console.log(`✅ Polling complete. Checked ${ordersChecked} orders. ${successfulRecharges} successful, ${failedRecharges} failed.`);
  } catch (error) {
    console.error('❌ Error in Cashfree Payment Polling cron job:', error);
  }
};

// Schedule the polling task. Adjust frequency as needed.
// For example, every 5 minutes: '*/5 * * * *'
// For example, every 1 minute for testing: '* * * * *'
cron.schedule('*/5 * * * *', pollCashfreePayments, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});

console.log('Cashfree Payment Polling scheduler is active. It will run every 5 minutes.');

// WEBHOOK ENDPOINT (kept as is, but it's no longer the primary method)
app.post('/webhook', async (req, res) => {
  console.log('--- Cashfree Webhook received ---', new Date().toISOString());

  const xWebhookTimestamp = req.headers['x-webhook-timestamp'];
  const xWebhookSignature = req.headers['x-webhook-signature'];
  const xWebhookVersion = req.headers['x-webhook-version'];
  const rawBody = req.rawBody;

  console.log('Webhook Headers:', { xWebhookTimestamp, xWebhookSignature, xWebhookVersion });
  console.log('Webhook Raw Body (length: ' + rawBody.length + '): ' + rawBody);

  if (!xWebhookTimestamp || !xWebhookSignature || !rawBody) {
    console.error('Webhook: Missing required headers or raw body for signature verification.');
    return res.status(400).send('Bad Request: Missing required webhook data.');
  }

  if (!CASHFREE_WEBHOOK_SECRET) {
    console.error('Webhook: CASHFREE_WEBHOOK_SECRET is not set or empty.');
    return res.status(500).send('Server Error: Webhook secret not configured.');
  }

  try {
    const dataToSign = xWebhookTimestamp + rawBody;
    const hmac = crypto.createHmac('sha256', CASHFREE_WEBHOOK_SECRET);
    hmac.update(dataToSign);
    const generatedSignature = hmac.digest('base64');

    if (generatedSignature !== xWebhookSignature) {
      console.error('Webhook: Invalid signature. Generated and received signatures did not match.');
      return res.status(401).send('Unauthorized: Invalid webhook signature.');
    }

    console.log('Webhook signature successfully verified.');

    const webhookData = req.body;
    console.log('Parsed Webhook Data:', webhookData);

    const eventType = webhookData.event;
    const orderDetails = webhookData.data.order;
    const paymentDetails = webhookData.data.payment;

    const orderId = orderDetails.order_id;
    const mobileNumber = orderDetails.customer_details ? orderDetails.customer_details.customer_phone : null;

    if (!orderId || !mobileNumber) {
      console.error('Webhook: Could not extract orderId or mobileNumber from webhook payload.', webhookData);
      return res.status(400).send('Bad Request: Invalid webhook payload structure.');
    }

    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK') {
      console.log(`Webhook: Payment success for Order ID: ${orderId}, Mobile: ${mobileNumber}`);
      const result = await processSuccessfulRecharge(orderId, mobileNumber);
      if (result.success) {
        return res.status(200).send('Webhook processed successfully.');
      } else {
        console.error(`Webhook: Failed to process successful recharge for Order ID ${orderId}: ${result.message}`);
        return res.status(200).send('Webhook received, but internal processing failed.');
      }
    } else if (eventType === 'PAYMENT_FAILED_WEBHOOK' || eventType === 'PAYMENT_USER_DROPPED_WEBHOOK') {
      console.log(`Webhook: Payment ${eventType} for Order ID: ${orderId}, Mobile: ${mobileNumber}`);
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

app.post('/trigger-deduction', async (req, res) => {
  console.log('Manually triggering deduction...');
  try {
    await performDeduction();
    res.status(200).json({ success: true, message: 'Deduction process finished successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Deduction process failed.', error: error.message });
  }
});

app.get('/test-cashfree-sample-signature', (req, res) => {
  const webhooksignatureFromSample = 'EhW2Z+rTcC337M2hJMR4GxmivdwZIwyadTScjy33HEc=';
  const postDataFromSample = `{"data":{"order":{"order_id":"qwert59954432221","order_amount":1.00,"order_currency":"INR","order_tags":null},"payment":{"cf_payment_id":5114917039291,"payment_status":"SUCCESS","payment_amount":1.00,"payment_currency":"INR","payment_message":"Simulated response message","payment_time":"2025-03-28T18:59:39+05:30","bank_reference":"1234567890","auth_id":null,"payment_method":{"upi":{"channel":null,"upi_id":"testsuccess@gocash"}},"payment_group":"upi"},"customer_details":{"customer_name":null,"customer_id":"devstudio_user","customer_email":"test123@gmail.com","customer_phone":"8474090589"}},"event_time":"2025-03-28T19:00:02+05:30","type":"PAYMENT_SUCCESS_WEBHOOK"}`;
  const timestampFromSample = '1743168602521';
  const secretKeyForTesting = 'caj1ueti8zo6626xdbxi';

  const signedPayloadSample = timestampFromSample + postDataFromSample;
  const hmacSample = crypto.createHmac('sha256', secretKeyForTesting);
  hmacSample.update(signedPayloadSample);
  const generatedSignatureForSample = hmacSample.digest('base64');

  const match = (webhooksignatureFromSample === generatedSignatureForSample);

  console.log(`--- Test /test-cashfree-sample-signature ---`);
  console.log(`Cashfree Sample Expected Signature: "${webhooksignatureFromSample}"`);
  console.log(`Your Generated Signature (for sample): "${generatedSignatureForSample}"`);
  console.log(`Match for Sample Data: ${match}`);
  console.log(`Signed Payload Length (Sample): ${signedPayloadSample.length}`);
  console.log(`Raw Body Length (Sample): ${postDataFromSample.length}`);
  console.log(`Timestamp (Sample): ${timestampFromSample}`);
  console.log(`Secret Key (Sample): "${secretKeyForTesting}"`);
  console.log(`--- End Test ---`);

  res.json({
      "message": "Check server logs for comparison result.",
      "Cashfree Sample Expected Signature": webhooksignatureFromSample,
      "Your Generated Signature (for sample)": generatedSignatureForSample,
      "Match": match
  });
});
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
