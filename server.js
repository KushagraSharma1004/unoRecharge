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

// Middleware to parse JSON and get raw body for webhook signature verification
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString(); // Store raw body for signature verification
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

// Initialize Cashfree SDK: Set static properties directly as required by the SDK version
Cashfree.XClientId = process.env.CLIENT_ID;
Cashfree.XClientSecret = process.env.CLIENT_SECRET;
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION; // Or Cashfree.Environment.SANDBOX (ensure this matches your Cashfree account)

// Cashfree Webhook Secret (MUST BE SET IN YOUR .env for webhook signature verification)
const CASHFREE_WEBHOOK_SECRET = process.env.CASHFREE_WEBHOOK_SECRET;

if (!CASHFREE_WEBHOOK_SECRET) {
  console.error("CRITICAL ERROR: CASHFREE_WEBHOOK_SECRET is not set in environment variables!");
  // In a production environment, you might want to stop the process here.
  // process.exit(1);
}

// --- Streamlined Function to Process Successful Recharge ---
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
      const rechargeAmount = Number(orderData.amount) || 0;
      const plan = orderData.plan;

      // 2. Add the removed thing (original order details) to recharges collection
      const rechargeHistoryRef = doc(db, `users/${mobileNumber}/recharges/${orderId}`);
      // Create a new object for recharge history, excluding 'status' field as per request
      const rechargeHistoryData = {
        timestamp: serverTimestamp(),
        plan: plan,
        amount: rechargeAmount,
        rechargeId: orderId, // Use orderId as the ID for recharge history document
        // status is implicitly 'SUCCESS' here, as per your request not to add it
        mobileNumber: orderData.mobileNumber, // Include original fields from temporary order
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

      // 4. Remove the order from rechargeOrderIds collection
      transaction.delete(temporaryOrderRef);
      console.log(`Temporary order ${orderId} removed from rechargesOrderIds for user ${mobileNumber}.`);

      console.log(`✅ Fully processed successful recharge for user ${mobileNumber}, Order ID: ${orderId}.`);
    });
    return { success: true, message: 'Recharge successfully processed.' };
  } catch (error) {
    console.error(`❌ Error during transaction for order ID ${orderId}, user ${mobileNumber}:`, error);
    // Log detailed error for debugging
    if (error.code) console.error(`Firestore error code: ${error.code}`);
    return { success: false, message: `Failed to process recharge: ${error.message}` };
  }
};


// --- Daily deduction cron job (retained, untouched) ---
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


// --- Create payment order endpoint (retained, untouched) ---
app.post('/create-order', async (req, res) => {
  try {
    const { plan, amount, planDetails, mobileNumber, shopName, orderId } = req.body;

    if (!plan || !amount || !planDetails || !mobileNumber || !shopName || !orderId) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Store order details temporarily in Firestore, to be updated/deleted by webhook
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
        // Return URL for Cashfree. This is where Cashfree redirects the user after payment.
        // It's client-side. The server-side webhook is independent for status updates.
        return_url: `https://your-frontend-domain.com/payment-status?order_id={order_id}&status={payment_status}`, // Use Cashfree dynamic parameters
        plan_details: planDetails
      }
    };

    // Call PGCreateOrder as a static method (fixed this in last response)
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


// --- Cashfree Webhook Endpoint (Added detailed debug logging) ---
app.post('/cashfree-webhook', async (req, res) => {
  console.log('--- Cashfree Webhook received ---', new Date().toISOString());

  const webhookHeaders = req.headers;
  const webhookTimestamp = webhookHeaders["x-webhook-timestamp"];
  const webhookSignature = webhookHeaders["x-webhook-signature"];
  const rawBody = req.rawBody; // Populated by the express.json middleware

  // Basic validation for critical headers
  if (!webhookTimestamp || !webhookSignature || !rawBody) {
    console.log("Webhook Error: Missing critical headers (x-webhook-timestamp, x-webhook-signature) or raw body.");
    return res.status(400).send("Missing required webhook headers or raw body.");
  }

  // Debugging: Log raw body for verification
  console.log("Webhook Raw Body from req.rawBody (length: " + rawBody.length + "):");
  console.log(rawBody); // Log the full raw body

  // Log the components used to generate the signature
  console.log(`Webhook Timestamp: "${webhookTimestamp}"`);
  console.log(`CASHFREE_WEBHOOK_SECRET (first 5 chars): "${CASHFREE_WEBHOOK_SECRET ? CASHFREE_WEBHOOK_SECRET.substring(0, 5) + '...' : 'NOT_SET'}"`);

  // Verify webhook signature (CRITICAL SECURITY STEP)
  try {
    const verified = Cashfree.verifySignature(webhookSignature, rawBody, webhookTimestamp, CASHFREE_WEBHOOK_SECRET);

    if (!verified) {
      console.log("Webhook Verification FAILED: Invalid signature. This webhook might be fraudulent or incorrectly configured.");
      console.log(`Expected Signature (from webhook): ${webhookSignature}`);
      // This is the string Cashfree uses for HMAC: timestamp + rawBody
      const stringForHmac = webhookTimestamp + rawBody;
      console.log(`String used for local HMAC (timestamp + rawBody): "${stringForHmac}"`);

      try {
          // Manually generate signature for comparison using Node's crypto
          const hmac = crypto.createHmac('sha256', CASHFREE_WEBHOOK_SECRET);
          hmac.update(stringForHmac);
          const localGeneratedSignature = hmac.digest('base64');
          console.log(`Locally Generated Signature: ${localGeneratedSignature}`);
          if (localGeneratedSignature === webhookSignature) {
              console.warn("WARNING: Manual HMAC matched, but Cashfree.verifySignature returned false. This indicates a potential SDK issue or environment difference.");
          }
      } catch (e) {
          console.error("Error generating local signature for comparison (check CASHFREE_WEBHOOK_SECRET):", e.message);
      }
      return res.status(401).send("Invalid signature.");
    }
    console.log("Webhook Verification SUCCESS: Signature matched.");
  } catch (error) {
    console.error("Webhook Verification ERROR: Exception during signature verification:", error);
    // If Cashfree.verifySignature throws an error, it's a serious issue.
    if (error.name === 'Error' && error.message.includes('Invalid x-client-secret')) {
        console.error("DEBUG: Likely issue with CASHFREE_WEBHOOK_SECRET being incorrect or malformed.");
    }
    return res.status(500).send("Signature verification internal error.");
  }

  // Extract relevant data from the webhook event
  const event = req.body; // req.body is the JSON parsed version
  const eventType = event.type;
  const orderId = event.data?.order?.order_id;
  const paymentStatus = event.data?.payment?.payment_status;
  // paymentAmount and customerPhone from webhook body are not directly passed to processSuccessfulRecharge anymore,
  // as it fetches from Firestore, but it's good to log them.
  const paymentAmount = event.data?.payment?.payment_amount;
  const customerPhone = event.data?.customer_details?.customer_phone;

  console.log(`Webhook Event Details: Type: ${eventType}, Order ID: ${orderId}, Payment Status: ${paymentStatus}, Customer Phone: ${customerPhone}`);

  // Process only PAYMENT_SUCCESS_WEBHOOK events with 'SUCCESS' status
  if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' && orderId && customerPhone && paymentStatus === 'SUCCESS') {
    try {
      // Call the streamlined processing function
      await processSuccessfulRecharge(orderId, customerPhone);
      res.status(200).send("OK"); // Respond OK after successful processing
    } catch (error) {
      console.error(`Webhook Processing Error for ${orderId}:`, error);
      res.status(500).send("Internal Server Error during recharge processing."); // Respond with error if processing fails
    }
  } else if (eventType === 'PAYMENT_FAILED_WEBHOOK' && orderId && customerPhone) {
    console.log(`Webhook: Payment FAILED for Order ID ${orderId}. Marking as failed in DB.`);
    const orderRef = doc(db, `users/${customerPhone}/rechargesOrderIds/${orderId}`);
    // Mark it as failed, don't delete yet for record-keeping.
    await setDoc(orderRef, { status: 'FAILED', timestamp: serverTimestamp() }, { merge: true }).catch(e => console.error("Error setting failed status:", e));
    res.status(200).send("OK - Payment marked as failed.");
  } else {
    // Acknowledge other webhook types (e.g., PAYMENT_PENDING, REFUND, etc.) but don't process balance
    console.log(`Webhook: Received event type ${eventType} with status ${paymentStatus}. No specific action defined.`);
    res.status(200).send("OK - Event received, no action taken.");
  }
});


// REMOVED: app.get('/test-cashfree-sample-signature', ...) // This endpoint is now removed as it was causing confusion.


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
