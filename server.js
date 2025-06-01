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
  serverTimestamp, // This is the function you need, correctly imported!
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
  // Correctly using doc(db, collectionPath, docId)
  const temporaryOrderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
  const userProfileRef = doc(db, 'users', mobileNumber);

  try {
      await runTransaction(db, async (transaction) => {
          // --- ALL READS MUST COME FIRST ---

          // Read 1: Get the user's profile to update balance
          const userProfileDoc = await transaction.get(userProfileRef);
          if (!userProfileDoc.exists()) {
              throw new Error(`User profile for ${mobileNumber} not found.`);
          }
          const currentBalance = userProfileDoc.data().balance || 0;

          // Read 2: Get the temporary order document to retrieve details for history
          const temporaryOrderDoc = await transaction.get(temporaryOrderRef);
          if (!temporaryOrderDoc.exists()) {
              console.warn(`Temporary order ${orderId} not found during successful processing. It might have been processed by another job or removed.`);
              throw new Error(`Temporary order ${orderId} not found, cannot proceed with processing.`);
          }
          const orderData = temporaryOrderDoc.data();

          // Ensure rechargeAmount is a number and exists
          const rechargeAmount = typeof orderData.amount === 'number' ? orderData.amount : parseFloat(orderData.amount) || 0;
          if (rechargeAmount <= 0) {
              throw new Error(`Invalid recharge amount received for order ${orderId}: ${orderData.amount}`);
          }

          // --- ALL WRITES MUST COME AFTER ALL READS ---

          // Write 1: Update user balance
          const newBalance = currentBalance + rechargeAmount;
          transaction.update(userProfileRef, { balance: newBalance });
          console.log(`Updated balance for user ${mobileNumber} to ${newBalance}.`);

          // Write 2: Add to recharge history
          // Correctly using collection(db, collectionPath) and doc() for auto-ID
          const rechargeHistoryRef = collection(db, `users/${mobileNumber}/rechargeHistory`);
          transaction.set(doc(rechargeHistoryRef), { // doc() here creates a new document with an auto-generated ID
              orderId: orderId,
              amount: rechargeAmount,
              status: 'SUCCESS',
              timestamp: serverTimestamp(), // Correct usage of serverTimestamp()
              paymentDetails: orderData.paymentDetails || {},
              originalTimestamp: orderData.timestamp
          });
          console.log(`Recharge history added for order ID ${orderId}, user ${mobileNumber}.`);

          // Write 3: Delete the temporary order
          transaction.delete(temporaryOrderRef);
          console.log(`Temporary order ${orderId} deleted.`);

          console.log(`Order ${orderId} for user ${mobileNumber} successfully processed.`);
      });
  } catch (error) {
      console.error(`❌ Error during transaction for order ID ${orderId}, user ${mobileNumber}:`, error.message);
      if (error.code) {
          console.error(`Firestore error code: ${error.code}`);
      }

      // Attempt to update the status of the temporary order to reflect the processing failure.
      // This update is outside the failed transaction.
      try {
          await setDoc(
              temporaryOrderRef,
              {
                  status: 'TRANSACTION_FAILED',
                  lastError: error.message,
                  processedAt: serverTimestamp() // Correct usage of serverTimestamp()
              },
              { merge: true }
          );
          console.log(`Updated temporary order ${orderId} to 'TRANSACTION_FAILED'.`);
      } catch (setErr) {
          console.error(`Failed to update temporary order ${orderId} status after transaction error:`, setErr.message);
      }
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
cron.schedule('* * * * *', performDeduction, {
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

        // ALWAYS log the raw data property of the response to see the actual payload
        console.log(`Cashfree API response 'data' for Order ID ${orderId}:`, JSON.stringify(cfResponse.data, null, 2));

        // CRITICAL CHANGE: Access cfResponse.data directly as the payments array
        // Use nullish coalescing to ensure it's always an array.
        const paymentsArray = cfResponse?.data ?? [];

        // Now, this check should correctly identify if the array is empty
        if (!Array.isArray(paymentsArray) || paymentsArray.length === 0) {
            console.warn(`Polling: No valid payment details (empty or non-array) found in Cashfree response for order ${orderId}. Checking max age.`);
            const orderAgeMs = Date.now() - orderInfo.timestamp.toMillis();
            if (orderAgeMs > MAX_PENDING_AGE_MINUTES * 60 * 1000) {
                console.warn(`Polling: Order ${orderId} for user ${mobileNumber} is too old (${MAX_PENDING_AGE_MINUTES}+ min) and no payment details found. Marking as 'STUCK_NO_CF_DATA'.`);
                await setDoc(temporaryOrderRef, { status: 'STUCK_NO_CF_DATA', processedAt: serverTimestamp() }, { merge: true });
            }
            continue; // Skip to the next order if no payments were found
        }

        // If we reach here, it means paymentsArray is a non-empty array.
        const payment = paymentsArray[0]; // Get the first payment object
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
