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
const processSuccessfulRecharge = async (orderId, mobileNumber, paymentDetails = {}) => {
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
          const rechargesRef = collection(db, `users/${mobileNumber}/recharges`);
          transaction.set(doc(rechargesRef), {
              orderId: orderId,
              amount: rechargeAmount,
              status: 'SUCCESS',
              timestamp: serverTimestamp(),
              paymentDetails: paymentDetails, // Use the passed paymentDetails
              originalTimestamp: orderData.timestamp // Keep original timestamp if needed
          });
          console.log(`Recharge history added for order ID ${orderId}, user ${mobileNumber}.`);

          // Write 3: Delete the temporary order
          transaction.delete(temporaryOrderRef);
          console.log(`Temporary order ${orderId} deleted.`);

          console.log(`Order ${orderId} for user ${mobileNumber} successfully processed.`);
      });
      return { success: true, message: `Recharge for order ${orderId} processed successfully.` };
  } catch (error) {
      console.error(`❌ Error during transaction for order ID ${orderId}, user ${mobileNumber}:`, error.message);
      if (error.code) {
          console.error(`Firestore error code: ${error.code}`);
      }

      // Attempt to update the status of the temporary order to reflect the processing failure.
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
      return { success: false, message: error.message };
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
cron.schedule('59 23 * * *', performDeduction, {
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

    // Store order details temporarily in Firestore
    const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
    await setDoc(orderRef, {
      plan: plan,
      amount: amount,
      timestamp: serverTimestamp(),
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
        // Return URL for Cashfree. User will be redirected here.
        // It's crucial that your frontend picks up the order_id and mobileNumber from this URL
        // and then calls your /verify endpoint.
        return_url: `https://unoshops.com/?order_id=${orderId}&mobileNumber=${mobileNumber}`,
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


// --- New Endpoint: Verify Payment Status from Frontend ---
app.post('/verify', async (req, res) => {
  const { orderId, mobileNumber } = req.body;

  if (!orderId || !mobileNumber) {
    return res.status(400).json({ success: false, message: 'orderId and mobileNumber are required.' });
  }

  const temporaryOrderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);

  try {
    console.log(`Verifying payment for Order ID: ${orderId}, User: ${mobileNumber}`);
    const cfResponse = await Cashfree.PGOrderFetchPayments("2023-08-01", orderId);

    console.log(`Cashfree API response 'data' for Order ID ${orderId}:`, JSON.stringify(cfResponse.data, null, 2));

    const paymentsArray = cfResponse?.data ?? [];

    if (!Array.isArray(paymentsArray) || paymentsArray.length === 0) {
      console.warn(`Verification: No valid payment details (empty or non-array) found in Cashfree response for order ${orderId}.`);
      await setDoc(temporaryOrderRef, { status: 'NO_CF_DATA', processedAt: serverTimestamp() }, { merge: true });
      return res.status(200).json({ success: false, status: 'NO_PAYMENT_DETAILS', message: 'No payment details found for this order.' });
    }

    const payment = paymentsArray[0]; // Get the first payment object
    const paymentStatus = payment.payment_status;

    console.log(`Verification: Cashfree reported Status for ${orderId}: ${paymentStatus}`);

    if (paymentStatus === 'SUCCESS') {
      console.log(`Verification: Payment confirmed as SUCCESS for Order ID ${orderId}. Initiating processing.`);
      const result = await processSuccessfulRecharge(orderId, mobileNumber, payment); // Pass payment details
      if (result.success) {
        return res.status(200).json({ success: true, status: 'SUCCESS', message: 'Recharge successful and balance updated.' });
      } else {
        // If processSuccessfulRecharge failed, it would have already updated the temp order status
        return res.status(500).json({ success: false, status: 'PROCESSING_FAILED', message: result.message });
      }
    } else if (paymentStatus === 'FAILED' || paymentStatus === 'CANCELLED') {
      console.log(`Verification: Payment ${orderId} confirmed as ${paymentStatus}. Marking in Firestore.`);
      await setDoc(temporaryOrderRef, { status: paymentStatus, processedAt: serverTimestamp() }, { merge: true });
      return res.status(200).json({ success: false, status: paymentStatus, message: `Recharge ${paymentStatus.toLowerCase()}.` });
    } else if (paymentStatus === 'PENDING') {
      console.log(`Verification: Payment ${orderId} is still PENDING. Frontend should try again or instruct user to wait.`);
      // We don't delete the temporary order here, as it's still pending
      return res.status(200).json({ success: false, status: 'PENDING', message: 'Payment is still pending. Please wait or try again later.' });
    } else {
      console.log(`Verification: Payment status for Order ID ${orderId} is: ${paymentStatus}. Unhandled status.`);
      await setDoc(temporaryOrderRef, { status: `UNHANDLED_STATUS_${paymentStatus}`, processedAt: serverTimestamp() }, { merge: true });
      return res.status(200).json({ success: false, status: 'UNHANDLED_STATUS', message: `Unhandled payment status: ${paymentStatus}.` });
    }
  } catch (error) {
    console.error(`❌ Verification Error for Order ID ${orderId}, User ${mobileNumber}:`, error.message);
    // Update temporary order status to indicate an error during verification
    await setDoc(temporaryOrderRef, { status: 'VERIFICATION_ERROR', lastError: error.message, processedAt: serverTimestamp() }, { merge: true });
    return res.status(500).json({ success: false, status: 'SERVER_ERROR', message: `Server error during verification: ${error.message}` });
  }
});

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

// REMOVED: Manual trigger for polling is no longer needed

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
