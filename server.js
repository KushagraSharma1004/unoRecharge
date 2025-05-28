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
  getDoc, // Added for fetching a single document
  setDoc, // Added for setting a single document (for recharges)
  deleteDoc, // Added for deleting a document (recharge order ID)
  runTransaction // Added for atomic operations
} = require('firebase/firestore');


const app = express();
app.use(cors());
app.use(express.json());

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

/**
 * Fetches all users and deducts a fixed amount from their balance.
 * This function also logs each deduction as a separate document.
 */
const performDeduction = async () => {
  try {
    console.log('Starting balance deduction process...', new Date().toISOString());

    const usersCol = collection(db, 'users');
    const usersSnapshot = await getDocs(usersCol);
    const deductionAmount = 12; // The amount to deduct

    if (usersSnapshot.empty) {
      console.log('No users found to process.', new Date().toISOString());
      return;
    }

    const batch = writeBatch(db);
    let processedCount = 0;

    usersSnapshot.forEach((userDoc) => {
      const userData = userDoc.data();
      const currentBalance = userData.balance || 0;

      // Only process users with a balance sufficient for the deduction
      if (currentBalance >= deductionAmount) {
        const newBalance = currentBalance - deductionAmount;

        // 1. Update the user's balance
        batch.update(userDoc.ref, {
          balance: newBalance,
          lastDeduction: serverTimestamp()
        });

        // 2. Create a record of this specific deduction
        const deductionsCol = collection(db, `users/${userDoc.id}/deductions`);
        const deductionRef = doc(deductionsCol); // Create a new doc with a unique ID
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

// --- CRON SCHEDULER ---
// This schedule runs the task every minute for testing.
// For a daily deduction at midnight, change it back to '0 0 * * *'.
cron.schedule('0 0 * * *', performDeduction, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});

console.log('Scheduler is active. Daily deduction will run at midnight (Asia/Kolkata time).');

// --- API ENDPOINTS ---

// Cashfree configuration
Cashfree.XClientId = process.env.CLIENT_ID;
Cashfree.XClientSecret = process.env.CLIENT_SECRET;
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION;


// Helper function to process successful recharge
const processSuccessfulRecharge = async (orderId, mobileNumber) => {
  // Use a Firestore transaction for atomicity
  try {
    await runTransaction(db, async (transaction) => {
      // 1. Fetch order details from Firestore
      const orderRef = doc(collection(db, `users/${mobileNumber}/rechargesOrderIds`), orderId);
      const orderSnap = await transaction.get(orderRef);

      if (!orderSnap.exists()) {
        throw new Error(`Order not found in Firestore for orderId: ${orderId}`);
      }

      const orderData = orderSnap.data();
      const rechargeAmount = Number(orderData.amount) || 0;
      const plan = orderData.plan;

      // 2. Add recharge record to `recharges` subcollection
      const rechargeDocRef = doc(db, `users/${mobileNumber}/recharges/${orderId}`);
      transaction.set(rechargeDocRef, {
        timestamp: serverTimestamp(), // Use serverTimestamp for consistency
        plan: plan,
        amount: rechargeAmount,
        rechargeId: orderId,
        // Add any other relevant details like UTR if available from Cashfree response
      });

      // 3. Update the user's main balance
      const userRef = doc(db, `users/${mobileNumber}`);
      const userSnap = await transaction.get(userRef);
      const userData = userSnap.data();
      const currentBalance = Number(userData.balance) || 0;

      let newBalance = currentBalance + rechargeAmount;
      if (plan === 'yearly') {
        newBalance += 720; // Add bonus for yearly plan
      }

      transaction.update(userRef, {
        balance: newBalance,
        lastRecharge: serverTimestamp() // Record last recharge timestamp
      });

      // 4. Delete the order from `rechargesOrderIds` to prevent double processing
      transaction.delete(orderRef);

      console.log(`✅ Recharge processed successfully for user ${mobileNumber}, Order ID: ${orderId}. New balance: ${newBalance}`);
    });
    return { success: true, message: 'Recharge successfully processed.' };
  } catch (error) {
    console.error(`❌ Error processing recharge for order ID ${orderId}:`, error);
    // Optionally, you might want to log this error to a dedicated error collection in Firestore
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

    // Save order details to Firestore before creating Cashfree order
    // This is important so you have the necessary details (plan, amount) when the webhook/verify endpoint is called.
    const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
    await setDoc(orderRef, {
      plan: plan,
      amount: amount,
      timestamp: serverTimestamp(),
      status: 'initiated', // Initial status
      mobileNumber: mobileNumber, // Store mobile number for easier lookup later
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
        // The return_url is primarily for client-side redirection.
        // The actual balance update should happen server-side via webhook or a robust verification.
        return_url: `https://unoshops.com`,
        plan_details: planDetails
      }
    };

    const response = await Cashfree.PGCreateOrder("2023-08-01", request);
    res.json(response.data);

  } catch (error) {
    console.error("Order creation error:", error);
    // Clean up the initiated order in Firestore if Cashfree order creation fails
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

// Verify payment endpoint (enhanced for balance update)
app.post('/verify', async (req, res) => {
  try {
    const { orderId, mobileNumber } = req.body; // mobileNumber is now required
    if (!orderId || !mobileNumber) {
      return res.status(400).json({ error: "Order ID and Mobile Number are required" });
    }

    const response = await Cashfree.PGOrderFetchPayments("2023-08-01", orderId);
    const cashfreePaymentStatus = response.data.order_status; // e.g., 'PAID', 'PENDING', 'FAILED'

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
      // If payment is not successful, update order status in Firestore and potentially delete
      const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
      await setDoc(orderRef, { status: cashfreePaymentStatus, timestamp: serverTimestamp() }, { merge: true });

      if (cashfreePaymentStatus === 'FAILED') {
         // Optionally delete failed orders after some time or immediately
         // For now, let's keep it for debugging, but in production, you might delete it.
         // await deleteDoc(orderRef);
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
      details: error.message // Provide more details for debugging
    });
  }
});

// Manual trigger endpoint
app.post('/trigger-deduction', async (req, res) => {
  console.log('Manually triggering deduction...');
  try {
    // Await the function to ensure it completes before sending the response
    await performDeduction();
    res.status(200).json({ success: true, message: 'Deduction process finished successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Deduction process failed.', error: error.message });
  }
});

const PORT = process.env.PORT || 9123;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
