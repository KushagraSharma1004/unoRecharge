// server.js (or app.js)
const express = require('express');
const cors = require('cors');
const { Cashfree } = require('cashfree-pg');
require('dotenv').config();
// const cron = require('node-cron'); // No longer needed here
const { initializeApp } = require('firebase/app');
// const schedule = require('node-schedule'); // No longer needed here
const {
  getFirestore,
  collection,
  // getDocs, // Only needed by cron jobs
  // writeBatch, // Only needed by cron jobs
  serverTimestamp,
  doc,
  // getDoc, // Only needed by cron jobs
  setDoc,
  deleteDoc,
  // runTransaction, // Only needed by cron jobs
  // query, // Only needed by cron jobs
  // where // Only needed by cron jobs
} = require('firebase/firestore');

const app = express();
app.use(cors());

app.use(express.json({ limit: '5mb' }));

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

Cashfree.XClientId = process.env.CLIENT_ID;
Cashfree.XClientSecret = process.env.CLIENT_SECRET;
// Set environment based on a separate ENV variable, e.g., process.env.NODE_ENV
Cashfree.XEnvironment = process.env.NODE_ENV === 'production' ? Cashfree.Environment.PRODUCTION : Cashfree.Environment.SANDBOX;

// --- Streamlined Function to Process Successful Recharge ---
// NOTE: This function is still needed by the polling job, but also potentially if you had
// a webhook from Cashfree that directly called it. If only the polling job uses it,
// you could move this function to pollingJob.js entirely and pass it where needed.
// For now, keeping it here assuming it might be called by other server-side logic (e.g., webhooks).
const processSuccessfulRecharge = async (orderId, mobileNumber, paymentDetails = {}) => {
  const temporaryOrderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
  const userProfileRef = doc(db, 'users', mobileNumber);

  try {
      await runTransaction(db, async (transaction) => {
          const userProfileDoc = await transaction.get(userProfileRef);
          if (!userProfileDoc.exists()) {
              throw new Error(`User profile for ${mobileNumber} not found.`);
          }
          const currentBalance = userProfileDoc.data().balance || 0;

          const temporaryOrderDoc = await transaction.get(temporaryOrderRef);
          if (!temporaryOrderDoc.exists()) {
              console.warn(`Temporary order ${orderId} not found during successful processing.`);
              throw new Error(`Temporary order ${orderId} not found, cannot proceed.`);
          }
          const orderData = temporaryOrderDoc.data();

          const rechargeAmount = typeof orderData.amount === 'number' ? orderData.amount : parseFloat(orderData.amount) || 0;
          if (rechargeAmount <= 0) {
              throw new Error(`Invalid recharge amount received for order ${orderId}: ${orderData.amount}`);
          }

          const newBalance = currentBalance + rechargeAmount;
          transaction.update(userProfileRef, { balance: newBalance });
          console.log(`Updated balance for user ${mobileNumber} to ${newBalance}.`);

          const rechargeHistoryRef = collection(db, `users/${mobileNumber}/rechargeHistory`);
          transaction.set(doc(rechargeHistoryRef), {
              orderId: orderId,
              amount: rechargeAmount,
              status: 'SUCCESS',
              timestamp: serverTimestamp(),
              paymentDetails: paymentDetails,
              originalInitiationTimestamp: orderData.timestamp
          });
          console.log(`Recharge history added for order ID ${orderId}, user ${mobileNumber}.`);

          transaction.delete(temporaryOrderRef);
          console.log(`Temporary order ${orderId} deleted.`);

          console.log(`Order ${orderId} for user ${mobileNumber} successfully processed.`);
      });
  } catch (error) {
      console.error(`❌ Error during transaction for order ID ${orderId}, user ${mobileNumber}:`, error.message);
      if (error.code) {
          console.error(`Firestore error code: ${error.code}`);
      }

      try {
          await setDoc(
              temporaryOrderRef,
              {
                  status: 'TRANSACTION_FAILED',
                  lastError: error.message,
                  processedAt: serverTimestamp()
              },
              { merge: true }
          );
          console.log(`Updated temporary order ${orderId} to 'TRANSACTION_FAILED'.`);
      } catch (setErr) {
          console.error(`Failed to update temporary order ${orderId} status after transaction error:`, setErr.message);
      }
  }
};


// --- Removed cron.schedule calls here ---
// They will now be handled by Render's dedicated Cron Jobs.

// --- Create payment order endpoint (Remains the same) ---
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
    console.log(`Order ${orderId} details saved to Firestore for user ${mobileNumber} with status 'initiated'.`);

    const request = {
      order_amount: amount,
      order_currency: "INR",
      order_id: orderId,
      customer_details: {
        customer_id: shopName,
        customer_phone: mobileNumber
      },
      order_meta: {
        return_url: `https://unoshops.com/payment-status?order_id=${orderId}&status={payment_status}&mobileNumber=${mobileNumber}`,
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

// --- Manual trigger endpoints (should call the external scripts if you want to test them) ---
// For manual testing, you could make these endpoints execute the external scripts,
// but for production, they should just confirm the cron jobs are set up.
// Or, if you keep them, ensure they still import the necessary functions or are simple for testing.
// For now, I'll keep them as they are, but note they will only work if the server is awake.
app.post('/trigger-deduction', async (req, res) => {
  console.log('Manually triggering deduction...');
  // In a truly separated setup, this would trigger the external job or just log a message.
  // For testing, you might still want to call `performDeduction` if it's imported.
  // To avoid circular dependencies and ensure proper separation, consider removing these manual triggers
  // or re-implementing them to directly invoke the external jobs (e.g., via a child process or specific API for internal calls).
  // For now, let's keep it minimal.
  res.status(200).json({ success: true, message: 'Manual deduction trigger initiated. Check cron job logs.' });
});

app.post('/trigger-polling', async (req, res) => {
  console.log('Manually triggering pending payment check...');
  res.status(200).json({ success: true, message: 'Manual polling trigger initiated. Check cron job logs.' });
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
