// pollingJob.js
const { Cashfree } = require('cashfree-pg');
const { initializeApp } = require('firebase/app');
const {
  getFirestore,
  collection,
  getDocs,
  writeBatch,
  serverTimestamp,
  doc,
  setDoc,
  runTransaction,
  query,
  where
} = require('firebase/firestore');
require('dotenv').config(); // Load environment variables

// --- Firebase Initialization ---
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

// --- Cashfree SDK Initialization ---
// IMPORTANT: Ensure these environment variables are set for your Render Cron Job
Cashfree.XClientId = process.env.CLIENT_ID;
Cashfree.XClientSecret = process.env.CLIENT_SECRET;
Cashfree.XEnvironment = process.env.NODE_ENV === 'production' ? Cashfree.Environment.PRODUCTION : Cashfree.Environment.SANDBOX;

// --- Streamlined Function to Process Successful Recharge (Copied from original) ---
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
              console.warn(`Temporary order ${orderId} not found during successful processing. It might have been processed by another job or removed.`);
              throw new Error(`Temporary order ${orderId} not found, cannot proceed with processing.`);
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
              paymentDetails: paymentDetails, // Pass actual payment details from Cashfree response
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

// --- Polling for pending payments logic ---
const POLL_INTERVAL_MINUTES = 5; // This value is for context, the Render cron will define the actual schedule
const MAX_PENDING_AGE_MINUTES = 30;

const checkPendingPayments = async () => {
  console.log(`--- Starting pending payment check (polling CRON JOB) ---`, new Date().toISOString());
  try {
    const usersSnapshot = await getDocs(collection(db, 'users'));

    if (usersSnapshot.empty) {
        console.log("No users found to check for pending orders (CRON JOB).");
        return;
    }

    let ordersToProcess = [];

    for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id; // Mobile number is the document ID for users
        const userOrdersRef = collection(db, `users/${userId}/rechargesOrderIds`);
        const fiveMinutesAgo = new Date(Date.now() - (5 * 60 * 1000)); // Orders older than 5 minutes
        const q = query(userOrdersRef,
            where('status', '==', 'initiated'),
            where('timestamp', '<', fiveMinutesAgo)
        );
        const initiatedOrdersSnap = await getDocs(q);

        initiatedOrdersSnap.forEach(orderDoc => {
            const orderData = orderDoc.data();
            ordersToProcess.push({
                orderId: orderDoc.id,
                mobileNumber: userId, // Use userId (mobileNumber) from the parent user doc
                shopName: orderData.shopName,
                timestamp: orderData.timestamp
            });
        });
    }

    if (ordersToProcess.length === 0) {
      console.log("No 'initiated' orders found that are old enough to be checked (CRON JOB).");
      return;
    }

    console.log(`Found ${ordersToProcess.length} pending orders to verify with Cashfree (CRON JOB).`);

    for (const orderInfo of ordersToProcess) {
      const { orderId, mobileNumber } = orderInfo;
      const temporaryOrderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);

      try {
        console.log(`Polling Cashfree for Order ID: ${orderId}, User: ${mobileNumber} (CRON JOB)`);
        const cfResponse = await Cashfree.PGOrderFetchPayments("2023-08-01", orderId);

        console.log(`Cashfree API response 'data' for Order ID ${orderId}:`, JSON.stringify(cfResponse.data, null, 2));

        const paymentsArray = cfResponse?.data ?? [];

        if (!Array.isArray(paymentsArray) || paymentsArray.length === 0) {
            console.warn(`Polling: No valid payment details found in Cashfree response for order ${orderId}. Checking max age (CRON JOB).`);
            const orderAgeMs = Date.now() - (orderInfo.timestamp?.toMillis() || 0);
            if (orderAgeMs > MAX_PENDING_AGE_MINUTES * 60 * 1000) {
                console.warn(`Polling: Order ${orderId} for user ${mobileNumber} is too old. Marking as 'STUCK_NO_CF_DATA' (CRON JOB).`);
                await setDoc(temporaryOrderRef, { status: 'STUCK_NO_CF_DATA', processedAt: serverTimestamp() }, { merge: true });
            }
            continue;
        }

        const payment = paymentsArray[0];
        const paymentStatus = payment.payment_status;

        console.log(`Polling: Cashfree reported Status for ${orderId}: ${paymentStatus} (CRON JOB).`);

        if (paymentStatus === 'SUCCESS') {
          console.log(`Polling: Payment confirmed as SUCCESS for Order ID ${orderId}. Initiating processing (CRON JOB).`);
          await processSuccessfulRecharge(orderId, mobileNumber, payment); // Pass payment details
        } else if (paymentStatus === 'FAILED' || paymentStatus === 'CANCELLED') {
          console.log(`Polling: Payment ${orderId} confirmed as ${paymentStatus}. Marking in Firestore (CRON JOB).`);
          await setDoc(temporaryOrderRef, { status: paymentStatus, processedAt: serverTimestamp() }, { merge: true });
        } else if (paymentStatus === 'PENDING') {
          console.log(`Polling: Payment ${orderId} is still PENDING. Will check again later (CRON JOB).`);
          await setDoc(temporaryOrderRef, { status: 'PENDING', lastChecked: serverTimestamp() }, { merge: true });
        } else {
          console.log(`Polling: Payment status for Order ID ${orderId} is: ${paymentStatus}. Marking as UNHANDLED (CRON JOB).`);
          await setDoc(temporaryOrderRef, { status: `UNHANDLED_${paymentStatus}`, processedAt: serverTimestamp() }, { merge: true });
        }
      } catch (error) {
        console.error(`Polling Error for Order ID ${orderId}, User ${mobileNumber}:`, error.message, `(CRON JOB)`);
        await setDoc(temporaryOrderRef, { status: 'POLLING_ERROR', lastError: error.message, processedAt: serverTimestamp() }, { merge: true });
      }
    }
    console.log(`--- Finished pending payment check (CRON JOB) ---`, new Date().toISOString());
  } catch (error) {
    console.error('❌ Polling for pending payments failed at top level (CRON JOB):', error, new Date().toISOString());
  } finally {
    // IMPORTANT: Exit the process cleanly for Render's cron job.
    console.log('Polling job finished. Exiting.');
    process.exit(0);
  }
};

// Execute the polling function when this script is run
checkPendingPayments();