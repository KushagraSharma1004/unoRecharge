const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Cashfree } = require('cashfree-pg'); // Correct import for Cashfree SDK
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
  query,
  where
} = require('firebase/firestore');

const app = express();
app.use(cors());

// IMPORTANT: Keep this for raw body parsing. Even if webhooks are removed,
// if you were previously using it for signature verification on a webhook
// and then switched back, or if any other part of your app needs raw body.
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

// CASHFREE_WEBHOOK_SECRET is not used directly in this code anymore,
// as the webhook endpoint has been removed. It's safe to keep in .env.
const CASHFREE_WEBHOOK_SECRET = process.env.CASHFREE_WEBHOOK_SECRET ? process.env.CASHFREE_WEBHOOK_SECRET.trim() : undefined;

// --- Initialize Cashfree SDK - Set static properties directly ---
// This is the correct way based on your logs indicating methods are not on an instance.
Cashfree.XClientId = process.env.CLIENT_ID;
Cashfree.XClientSecret = process.env.CLIENT_SECRET;
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION; // Ensure this is correct (PRODUCTION or SANDBOX)

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
      status: 'initiated', // Mark as initiated, needs verification via polling
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
        // Return URL for Cashfree. It won't trigger backend logic directly now.
        // It should lead to a page that informs the user the payment is being processed.
        return_url: `https://your-frontend-domain.com/payment-processing?order_id=${orderId}`,
        plan_details: planDetails
      }
    };

    // Correct way to call PGCreateOrder as a static method
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

const pollCashfreePayments = async () => {
  console.log('--- Starting Cashfree Payment Polling ---', new Date().toISOString());
  try {
    const usersSnapshot = await getDocs(collection(db, 'users'));
    if (usersSnapshot.empty) {
      console.log('No users found for polling.');
      return;
    }

    let ordersChecked = 0;
    let successfulRecharges = 0;
    let failedRecharges = 0;

    for (const userDoc of usersSnapshot.docs) {
      const mobileNumber = userDoc.id;

      // Query for orders that are 'initiated' or 'PENDING' within the last 24 hours.
      // IMPORTANT: This query requires a Firestore composite index.
      // See the "Action Required: Create Firestore Index" section below for details.
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const pendingOrdersQuery = query(
          collection(db, `users/${mobileNumber}/rechargesOrderIds`),
          where('timestamp', '>', twentyFourHoursAgo),
          where('status', 'in', ['initiated', 'PENDING'])
      );
      const pendingOrdersSnapshot = await getDocs(pendingOrdersQuery);

      if (pendingOrdersSnapshot.empty) {
        continue;
      }

      for (const orderDoc of pendingOrdersSnapshot.docs) {
        const orderId = orderDoc.id;
        const currentStatusInDB = orderDoc.data().status;

        console.log(`Polling Cashfree for Order ID: ${orderId} (User: ${mobileNumber}) with current DB status: ${currentStatusInDB}`);
        ordersChecked++;

        try {
          // Correct way to call PGVerifyPayment as a static method
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
              const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
              await setDoc(orderRef, { status: 'SUCCESS_INTERNAL_FAILURE', timestamp: serverTimestamp() }, { merge: true });
            }
          } else if (paymentStatus === 'FAILED' || paymentStatus === 'USER_DROPPED') {
            console.log(`Payment ${paymentStatus} detected for Order ID ${orderId}. Updating status in DB.`);
            failedRecharges++;
            const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
            await setDoc(orderRef, { status: paymentStatus, timestamp: serverTimestamp() }, { merge: true });
          } else if (paymentStatus === 'PENDING') {
              console.log(`Order ${orderId} is still PENDING with Cashfree. Updating DB status.`);
              const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
              await setDoc(orderRef, { status: 'PENDING', timestamp: serverTimestamp() }, { merge: true });
          } else { // Handle other statuses like CANCELLED, EXPIRED, etc.
            console.log(`Unhandled Cashfree status for Order ID ${orderId}: ${paymentStatus}. Marking in DB.`);
            const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
            await setDoc(orderRef, { status: `CF_${paymentStatus}`, timestamp: serverTimestamp() }, { merge: true });
          }
        } catch (pollError) {
          console.error(`❌ Error during Cashfree polling for order ID ${orderId}:`, pollError.response?.data || pollError.message);
          // For network errors or unexpected Cashfree API responses, you might want to log more details
          // and consider a mechanism for retries or manual intervention.
        }
      }
    }
    console.log(`✅ Polling complete. Checked ${ordersChecked} orders. ${successfulRecharges} successful, ${failedRecharges} failed.`);
  } catch (error) {
    console.error('❌ Error in Cashfree Payment Polling cron job:', error);
  }
};

// Schedule the polling task. Runs every 5 minutes.
cron.schedule('*/5 * * * *', pollCashfreePayments, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});

console.log('Cashfree Payment Polling scheduler is active. It will run every 5 minutes.');

// --- WEBHOOK ENDPOINT HAS BEEN REMOVED ENTIRELY ---
// As per your request, there is no webhook listener in this code.

app.post('/trigger-deduction', async (req, res) => {
  console.log('Manually triggering deduction...');
  try {
    await performDeduction();
    res.status(200).json({ success: true, message: 'Deduction process finished successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Deduction process failed.', error: error.message });
  }
});

// Test endpoint for Cashfree sample signature (kept for independent testing if needed)
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
  console.log(`Your Generated Signature (for sample)": "${generatedSignatureForSample}"`);
  console.log(`Match for Sample Data: ${match}`);
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
