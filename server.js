const express = require('express');
const cors = require('cors');
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
  query, // Added for querying initiated orders
  where // Added for querying initiated orders
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
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION; // Or Cashfree.Environment.SANDBOX

// --- Streamlined Function to Process Successful Recharge ---
const processSuccessfulRecharge = async (orderId, mobileNumber) => {
  try {
    await runTransaction(db, async (transaction) => {
      const temporaryOrderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
      const temporaryOrderSnap = await transaction.get(temporaryOrderRef);

      if (!temporaryOrderSnap.exists()) {
        console.warn(`Transaction Warning: Temporary order ${orderId} for user ${mobileNumber} not found during processing. It might be already processed or never created.`);
        return;
      }

      const orderData = temporaryOrderSnap.data();
      // Ensure the order hasn't been marked as 'SUCCESS' already by a previous attempt
      if (orderData.status === 'SUCCESS') {
          console.warn(`Transaction Warning: Order ${orderId} for user ${mobileNumber} already processed as SUCCESS.`);
          return;
      }

      const rechargeAmount = Number(orderData.amount) || 0;
      const plan = orderData.plan;

      const rechargeHistoryRef = doc(db, `users/${mobileNumber}/recharges/${orderId}`);
      const rechargeHistoryData = {
        timestamp: serverTimestamp(),
        plan: plan,
        amount: rechargeAmount,
        rechargeId: orderId,
        status: 'SUCCESS',
        mobileNumber: orderData.mobileNumber,
        shopName: orderData.shopName
      };
      transaction.set(rechargeHistoryRef, rechargeHistoryData);
      console.log(`Recharge history added for order ID ${orderId}, user ${mobileNumber}.`);

      const userRef = doc(db, `users/${mobileNumber}`);
      const userSnap = await transaction.get(userRef);
      const userData = userSnap.data();
      const currentBalance = Number(userData.balance) || 0;

      let newBalance = currentBalance + rechargeAmount;
      if (plan === 'yearly') {
        newBalance += 720;
        console.log(`Yearly bonus applied for user ${mobileNumber}.`);
      }

      transaction.update(userRef, {
        balance: newBalance,
        lastRecharge: serverTimestamp()
      });
      console.log(`User ${mobileNumber} balance updated to ${newBalance}.`);

      // Update the temporary order status to 'SUCCESS' before deleting (for robust logging)
      transaction.update(temporaryOrderRef, {
          status: 'SUCCESS',
          processedAt: serverTimestamp(),
          // Add a field to indicate it was processed by polling
          processedBy: 'polling'
      });
      console.log(`Temporary order ${orderId} status updated to SUCCESS for user ${mobileNumber}.`);

      // Remove the order from rechargeOrderIds collection (after successful processing)
      transaction.delete(temporaryOrderRef);
      console.log(`Temporary order ${orderId} removed from rechargesOrderIds for user ${mobileNumber}.`);

      console.log(`✅ Fully processed successful recharge for user ${mobileNumber}, Order ID: ${orderId}.`);
    });
    return { success: true, message: 'Recharge successfully processed.' };
  } catch (error) {
    console.error(`❌ Error during transaction for order ID ${orderId}, user ${mobileNumber}:`, error);
    if (error.code) console.error(`Firestore error code: ${error.code}`);
    return { success: false, message: `Failed to process recharge: ${error.message}` };
  }
};


// --- Daily deduction cron job: Runs at 12 PM (noon) Asia/Kolkata time ---
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

// Cron schedule for 12 PM (noon) daily (0 minutes, 12 hours)
cron.schedule('0 12 * * *', performDeduction, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});

console.log('Scheduler is active. Daily deduction will run at 12 PM (noon) Asia/Kolkata time.');


// --- Create payment order endpoint ---
app.post('/create-order', async (req, res) => {
  try {
    const { plan, amount, planDetails, mobileNumber, shopName, orderId } = req.body;

    if (!plan || !amount || !planDetails || !mobileNumber || !shopName || !orderId) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Store order details temporarily in Firestore, to be picked up by the polling job
    const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
    await setDoc(orderRef, {
      plan: plan,
      amount: amount,
      timestamp: serverTimestamp(),
      status: 'initiated', // Mark as initiated, to be polled later
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
        // Return URL for Cashfree. User will be redirected here.
        // The server will poll for status, so client-side doesn't need to trigger /verify-payment-status
        return_url: `https://unoshops.com/payment-status?order_id=${orderId}&status={payment_status}&mobileNumber=${mobileNumber}`,
        plan_details: planDetails
      }
    };

    const response = await Cashfree.PGCreateOrder("2023-08-01", request);
    res.json(response.data);
  } catch (error) {
    console.error("Order creation error:", error);
    // Clean up initiated order in Firestore if Cashfree order creation fails
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

// --- NEW CRON JOB: Polling for pending payments ---
const POLL_INTERVAL_MINUTES = 5; // How often to check for pending orders
const MAX_PENDING_AGE_MINUTES = 30; // How long to keep polling an order before considering it failed/stuck

const checkPendingPayments = async () => {
  console.log(`--- Starting pending payment check (polling) ---`, new Date().toISOString());
  try {
    const initiatedOrdersCollectionGroup = collection(db, 'users');
    const usersSnapshot = await getDocs(initiatedOrdersCollectionGroup);

    if (usersSnapshot.empty) {
        console.log("No users found to check for pending orders.");
        return;
    }

    let ordersToProcess = [];

    for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        const userOrdersRef = collection(db, `users/${userId}/rechargesOrderIds`);
        const fiveMinutesAgo = new Date(Date.now() - (5 * 60 * 1000));
        const q = query(userOrdersRef,
            where('status', '==', 'initiated'),
            where('timestamp', '<', fiveMinutesAgo)
        );
        const initiatedOrdersSnap = await getDocs(q);

        initiatedOrdersSnap.forEach(orderDoc => {
            const orderData = orderDoc.data();
            ordersToProcess.push({
                orderId: orderDoc.id,
                mobileNumber: orderData.mobileNumber,
                shopName: orderData.shopName,
                timestamp: orderData.timestamp
            });
        });
    }

    if (ordersToProcess.length === 0) {
      console.log("No 'initiated' orders found that are old enough to be checked.");
      return;
    }

    console.log(`Found ${ordersToProcess.length} pending orders to verify with Cashfree.`);

    for (const orderInfo of ordersToProcess) {
      const { orderId, mobileNumber } = orderInfo;
      const temporaryOrderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);

      try {
        console.log(`Polling Cashfree for Order ID: ${orderId}, User: ${mobileNumber}`);
        const cfResponse = await Cashfree.PGOrderFetchPayments("2023-08-01", orderId);

        // --- REVISED LOGIC FOR DATA CHECK AND PROCESSING ---

        // 1. Basic check for top-level response and data property
        if (!cfResponse || !cfResponse.data) {
            console.warn(`Polling: Received empty or invalid top-level response from Cashfree for order ${orderId}. Skipping this order.`);
            continue; // Skip to the next order in the loop
        }

        // 2. Log the data property only after confirming it exists
        console.log(`Cashfree API response 'data' for Order ID ${orderId}:`, JSON.stringify(cfResponse.data, null, 2));

        const paymentsArray = cfResponse.data.payments;

        // 3. Check if the payments array is missing or empty
        if (!paymentsArray || paymentsArray.length === 0) {
            console.warn(`Polling: No payment details (or empty payments array) found in Cashfree response for order ${orderId}. Checking max age.`);
            const orderAgeMs = Date.now() - orderInfo.timestamp.toMillis();
            if (orderAgeMs > MAX_PENDING_AGE_MINUTES * 60 * 1000) {
                console.warn(`Polling: Order ${orderId} for user ${mobileNumber} is too old (${MAX_PENDING_AGE_MINUTES}+ min) and no payment details found. Marking as 'STUCK_NO_CF_DATA'.`);
                await setDoc(temporaryOrderRef, { status: 'STUCK_NO_CF_DATA', processedAt: serverTimestamp() }, { merge: true });
            }
            continue; // Skip to the next order if no payments
        }

        // If we reach here, it means paymentsArray exists and has at least one element.
        const payment = paymentsArray[0]; // Assuming one payment per order for now
        const paymentStatus = payment.payment_status;

        console.log(`Polling: Cashfree reported Status for ${orderId}: ${paymentStatus}`);

        if (paymentStatus === 'SUCCESS') {
          console.log(`Polling: Payment confirmed as SUCCESS for Order ID ${orderId}. Initiating processing.`);
          await processSuccessfulRecharge(orderId, mobileNumber);
        } else if (paymentStatus === 'FAILED' || paymentStatus === 'CANCELLED') {
          console.log(`Polling: Payment ${orderId} confirmed as ${paymentStatus}. Marking in Firestore.`);
          await setDoc(temporaryOrderRef, { status: paymentStatus, processedAt: serverTimestamp() }, { merge: true });
        } else if (paymentStatus === 'PENDING') {
          console.log(`Polling: Payment ${orderId} is still PENDING. Will check again later.`);
          await setDoc(temporaryOrderRef, { status: 'PENDING', lastChecked: serverTimestamp() }, { merge: true });
        } else {
          console.log(`Polling: Payment status for Order ID ${orderId} is: ${paymentStatus}. No specific action defined yet.`);
        }
      } catch (error) {
        console.error(`Polling Error for Order ID ${orderId}, User ${mobileNumber}:`, error.message);
        await setDoc(temporaryOrderRef, { status: 'POLLING_ERROR', lastError: error.message, processedAt: serverTimestamp() }, { merge: true });
      }
    }
    console.log(`--- Finished pending payment check ---`, new Date().toISOString());
  } catch (error) {
    console.error('❌ Polling for pending payments failed at top level:', error, new Date().toISOString());
  }
};

// Schedule the polling job to run every X minutes
cron.schedule(`*/${POLL_INTERVAL_MINUTES} * * * *`, checkPendingPayments, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});

console.log(`Polling for pending payments is active. Runs every ${POLL_INTERVAL_MINUTES} minutes.`);


// Manual trigger for deduction (retained, untouched)
app.post('/trigger-deduction', async (req, res) => {
  console.log('Manually triggering deduction...');
  try {
    await performDeduction();
    res.status(200).json({ success: true, message: 'Deduction process finished successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Deduction process failed.', error: error.message });
  }
});

// Manual trigger for polling (for testing)
app.post('/trigger-polling', async (req, res) => {
  console.log('Manually triggering pending payment check...');
  try {
    await checkPendingPayments();
    res.status(200).json({ success: true, message: 'Pending payment check finished successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Pending payment check failed.', error: error.message });
  }
});


const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
