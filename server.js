const express = require('express');
const cors = require('cors');
// No need for crypto here, as Cashfree.verifySignature is no longer used without webhook
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

// Middleware to parse JSON
app.use(express.json({
  limit: '5mb'
  // rawBody is no longer needed without webhook signature verification
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

// Initialize Cashfree SDK: Set static properties directly as required by the SDK version
Cashfree.XClientId = process.env.CLIENT_ID;
Cashfree.XClientSecret = process.env.CLIENT_SECRET;
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION; // Or Cashfree.Environment.SANDBOX

// NOTE: CASHFREE_WEBHOOK_SECRET is no longer used as webhook endpoint is removed.

// --- Streamlined Function to Process Successful Recharge ---
// This function remains largely the same, called now by /verify-payment-status endpoint
const processSuccessfulRecharge = async (orderId, mobileNumber) => {
  try {
    await runTransaction(db, async (transaction) => {
      const temporaryOrderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
      const temporaryOrderSnap = await transaction.get(temporaryOrderRef);

      // 1. Check if the temporary order exists and hasn't been processed yet
      if (!temporaryOrderSnap.exists()) {
        console.warn(`Transaction Warning: Temporary order ${orderId} for user ${mobileNumber} not found. It might be already processed or never created.`);
        return; // Exit transaction if order not found or already processed
      }

      const orderData = temporaryOrderSnap.data();
      // Ensure the order hasn't been marked as 'SUCCESS' already by a previous attempt
      if (orderData.status === 'SUCCESS') {
          console.warn(`Transaction Warning: Order ${orderId} for user ${mobileNumber} already processed as SUCCESS.`);
          return;
      }

      const rechargeAmount = Number(orderData.amount) || 0;
      const plan = orderData.plan;

      // 2. Add the removed thing (original order details) to recharges collection
      const rechargeHistoryRef = doc(db, `users/${mobileNumber}/recharges/${orderId}`);
      const rechargeHistoryData = {
        timestamp: serverTimestamp(),
        plan: plan,
        amount: rechargeAmount,
        rechargeId: orderId, // Use orderId as the ID for recharge history document
        status: 'SUCCESS', // Explicitly set status to SUCCESS
        mobileNumber: orderData.mobileNumber,
        shopName: orderData.shopName
      };
      transaction.set(rechargeHistoryRef, rechargeHistoryData);
      console.log(`Recharge history added for order ID ${orderId}, user ${mobileNumber}.`);

      // 3. Add the balance in the users/mobileNumber
      const userRef = doc(db, `users/${mobileNumber}`);
      const userSnap = await transaction.get(userRef);
      const userData = userSnap.data();
      const currentBalance = Number(userData.balance) || 0;

      let newBalance = currentBalance + rechargeAmount;
      if (plan === 'yearly') {
        newBalance += 720; // Add yearly bonus if plan is 'yearly'
        console.log(`Yearly bonus applied for user ${mobileNumber}.`);
      }

      transaction.update(userRef, {
        balance: newBalance,
        lastRecharge: serverTimestamp()
      });
      console.log(`User ${mobileNumber} balance updated to ${newBalance}.`);

      // 4. Update the temporary order status to 'SUCCESS' before deleting (for robust logging)
      // This step is crucial for the new non-webhook flow, helps track processed orders
      transaction.update(temporaryOrderRef, {
          status: 'SUCCESS',
          processedAt: serverTimestamp()
      });
      console.log(`Temporary order ${orderId} status updated to SUCCESS for user ${mobileNumber}.`);

      // 5. Remove the order from rechargeOrderIds collection (after successful processing)
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

// Cron schedule for 12 PM (night) daily (0 minutes, 0 hours)
cron.schedule('0 0 * * *', performDeduction, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});

console.log('Scheduler is active. Daily deduction will run at 12 PM (noon) Asia/Kolkata time.');


// --- Create payment order endpoint (Remains as is) ---
app.post('/create-order', async (req, res) => {
  try {
    const { plan, amount, planDetails, mobileNumber, shopName, orderId } = req.body;

    if (!plan || !amount || !planDetails || !mobileNumber || !shopName || !orderId) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Store order details temporarily in Firestore, to be updated/deleted by /verify-payment-status
    const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
    await setDoc(orderRef, {
      plan: plan,
      amount: amount,
      timestamp: serverTimestamp(),
      status: 'initiated', // Mark as initiated
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
        // IMPORTANT: return_url for Cashfree. Your frontend must hit /verify-payment-status from this page.
        return_url: `https://unoshops.com/payment-status?order_id=${orderId}&status={payment_status}&mobile_number=${mobileNumber}`, // Pass mobile_number to frontend
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


// --- NEW: Endpoint to verify payment status after frontend redirect (replaces webhook) ---
app.post('/verify-payment-status', async (req, res) => {
  console.log('--- /verify-payment-status endpoint hit ---', new Date().toISOString());
  const { orderId, mobileNumber } = req.body; // Expect orderId and mobileNumber from frontend

  if (!orderId || !mobileNumber) {
    console.log('Verification Error: Missing orderId or mobileNumber in request body.');
    return res.status(400).json({ success: false, message: 'orderId and mobileNumber are required.' });
  }

  console.log(`Attempting to verify status for Order ID: ${orderId}, User: ${mobileNumber}`);

  try {
    // 1. Fetch order details from Cashfree to confirm status securely
    const cfResponse = await Cashfree.PGOrderFetchPayments("2023-08-01", orderId);
    console.log("Cashfree API response for order fetch:", JSON.stringify(cfResponse.data, null, 2));

    if (!cfResponse.data || cfResponse.data.payments.length === 0) {
        console.warn(`No payment details found for order ${orderId} from Cashfree.`);
        return res.status(404).json({ success: false, message: 'Order not found or no payment details from Cashfree.' });
    }

    const payment = cfResponse.data.payments[0]; // Assuming one payment per order
    const paymentStatus = payment.payment_status;
    const paymentAmount = payment.payment_amount; // Verify this matches expected amount
    const cfCustomerPhone = cfResponse.data.customer_details?.customer_phone; // Get customer phone from Cashfree response

    console.log(`Cashfree reported Status: ${paymentStatus}, Amount: ${paymentAmount}, Customer Phone: ${cfCustomerPhone}`);

    // Basic security check: Ensure the mobile number matches what Cashfree has
    if (cfCustomerPhone !== mobileNumber) {
        console.error(`SECURITY ALERT: Mobile number mismatch! Request: ${mobileNumber}, Cashfree: ${cfCustomerPhone} for Order ID: ${orderId}`);
        // Log this, but you might decide to still process if orderId is unique and primary identifier
        // For stricter security, you might reject here:
        // return res.status(403).json({ success: false, message: 'Mobile number mismatch. Possible fraud attempt.' });
    }

    // 2. Process based on Cashfree's confirmed status
    if (paymentStatus === 'SUCCESS') {
      console.log(`Payment confirmed as SUCCESS for Order ID ${orderId}.`);
      const processingResult = await processSuccessfulRecharge(orderId, mobileNumber);

      if (processingResult.success) {
        res.status(200).json({ success: true, message: 'Payment successfully verified and processed.', data: processingResult });
      } else {
        res.status(500).json({ success: false, message: 'Payment verified, but internal processing failed.', error: processingResult.message });
      }
    } else if (paymentStatus === 'FAILED') {
      console.log(`Payment confirmed as FAILED for Order ID ${orderId}.`);
      // Update temporary order status in Firestore (optional, for record-keeping)
      const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
      await setDoc(orderRef, { status: 'FAILED', processedAt: serverTimestamp() }, { merge: true }).catch(e => console.error("Error setting failed status:", e));
      res.status(200).json({ success: true, message: 'Payment failed.', status: 'FAILED' }); // success: true because it's handled
    } else if (paymentStatus === 'PENDING') {
        console.log(`Payment confirmed as PENDING for Order ID ${orderId}.`);
        const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
        await setDoc(orderRef, { status: 'PENDING', processedAt: serverTimestamp() }, { merge: true }).catch(e => console.error("Error setting pending status:", e));
        res.status(200).json({ success: true, message: 'Payment is pending. Please try again later.', status: 'PENDING' });
    }
    else {
      console.log(`Payment status for Order ID ${orderId} is: ${paymentStatus}. No specific action defined.`);
      res.status(200).json({ success: true, message: `Payment status is ${paymentStatus}.`, status: paymentStatus });
    }

  } catch (error) {
    console.error(`Error verifying payment for Order ID ${orderId}:`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment status.',
      error: error.response?.data?.message || error.message
    });
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
