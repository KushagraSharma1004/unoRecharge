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
  query,
  where
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
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION; // Or Cashfree.Environment.SANDBOX

// Cashfree Webhook Secret (MUST BE SET IN YOUR .env)
const CASHFREE_WEBHOOK_SECRET = process.env.CASHFREE_WEBHOOK_SECRET;

if (!CASHFREE_WEBHOOK_SECRET) {
  console.error("CRITICAL ERROR: CASHFREE_WEBHOOK_SECRET is not set in environment variables!");
  // Depending on severity, you might want to exit or throw an error here.
  // process.exit(1);
}

// Function to process a successful recharge transaction
const processSuccessfulRecharge = async (orderId, mobileNumber, rechargeAmount, plan) => {
  try {
    await runTransaction(db, async (transaction) => {
      const orderRef = doc(db, `users/${mobileNumber}/rechargesOrderIds/${orderId}`);
      const orderSnap = await transaction.get(orderRef);

      // Check if the order document exists and is not already processed
      if (!orderSnap.exists() || orderSnap.data().status === 'SUCCESS') {
        console.log(`Webhook: Order ${orderId} for user ${mobileNumber} not found or already processed. Skipping.`);
        return { success: true, message: 'Order not found or already processed.' };
      }

      // Update user balance
      const userRef = doc(db, `users/${mobileNumber}`);
      const userSnap = await transaction.get(userRef);
      const userData = userSnap.data();
      const currentBalance = Number(userData.balance) || 0;

      let newBalance = currentBalance + rechargeAmount;
      if (plan === 'yearly') {
        newBalance += 720; // Add yearly bonus
      }

      transaction.update(userRef, {
        balance: newBalance,
        lastRecharge: serverTimestamp()
      });

      // Add recharge history
      const rechargeDocRef = doc(db, `users/${mobileNumber}/recharges/${orderId}`);
      transaction.set(rechargeDocRef, {
        timestamp: serverTimestamp(),
        plan: plan,
        amount: rechargeAmount,
        rechargeId: orderId,
        status: 'SUCCESS'
      });

      // Mark the temporary order ID as processed/delete it
      transaction.delete(orderRef); // Or set status: 'PROCESSED' if you want to keep records

      console.log(`✅ Recharge processed successfully for user ${mobileNumber}, Order ID: ${orderId}. New balance: ${newBalance}`);
    });
    return { success: true, message: 'Recharge successfully processed.' };
  } catch (error) {
    console.error(`❌ Error processing recharge for order ID ${orderId}:`, error);
    return { success: false, message: `Failed to process recharge: ${error.message}` };
  }
};

// Daily deduction cron job (retained as per your original code)
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


// Create payment order endpoint
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
        // Return URL: This is where Cashfree redirects the user after payment.
        // It's client-side, but the webhook is server-side.
        return_url: `https://your-frontend-domain.com/payment-status?order_id={order_id}&status={payment_status}`, // Use Cashfree dynamic parameters
        plan_details: planDetails
      }
    };

    // Call PGCreateOrder as a static method
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


// --- Re-introducing Cashfree Webhook Endpoint ---
// This is the direct way to get payment success notifications from Cashfree.
// It is essential for immediate balance updates without polling.
app.post('/cashfree-webhook', async (req, res) => {
  console.log('--- Cashfree Webhook received ---', new Date().toISOString());

  const webhookHeaders = req.headers;
  const webhookTimestamp = webhookHeaders["x-webhook-timestamp"];
  const webhookSignature = webhookHeaders["x-webhook-signature"];
  const webhookVersion = webhookHeaders["x-webhook-version"];
  const rawBody = req.rawBody; // Already populated by the express.json middleware

  if (!webhookTimestamp || !webhookSignature || !webhookVersion || !rawBody) {
    console.log("Webhook: Missing required headers or raw body.");
    return res.status(400).send("Missing required headers or raw body.");
  }

  // Debugging: Log received headers and raw body
  console.log("Webhook Headers:", webhookHeaders);
  console.log("Webhook Raw Body (length: " + rawBody.length + "):", rawBody);

  // Verify webhook signature
  try {
    const verified = Cashfree.verifySignature(webhookSignature, rawBody, webhookTimestamp, CASHFREE_WEBHOOK_SECRET);

    if (!verified) {
      console.log("Webhook: Invalid signature. Generated and received signatures did not match.");
      return res.status(401).send("Invalid signature.");
    }
    console.log("Webhook: Signature verified successfully.");
  } catch (error) {
    console.error("Webhook: Error verifying signature:", error);
    return res.status(500).send("Signature verification failed.");
  }

  const event = req.body;
  const eventType = event.type;
  const orderId = event.data?.order?.order_id;
  const paymentStatus = event.data?.payment?.payment_status;
  const paymentAmount = event.data?.payment?.payment_amount;
  const customerPhone = event.data?.customer_details?.customer_phone;
  const planDetails = event.data?.order?.order_meta?.plan_details; // Assuming you pass plan in order_meta

  console.log(`Webhook Event: ${eventType}, Order ID: ${orderId}, Status: ${paymentStatus}, User: ${customerPhone}`);

  if (eventType === 'PAYMENT_SUCCESS_WEBHOOK' && orderId && customerPhone && paymentStatus === 'SUCCESS') {
    // Retrieve plan details if stored in your 'rechargesOrderIds' or from the webhook directly
    // For now, we'll try to get it from the `rechargesOrderIds` document, which should have the plan
    try {
        const orderDocRef = doc(db, `users/${customerPhone}/rechargesOrderIds/${orderId}`);
        const orderDocSnap = await getDoc(orderDocRef);
        if (orderDocSnap.exists()) {
            const orderData = orderDocSnap.data();
            const plan = orderData.plan; // Get the plan from your stored order
            await processSuccessfulRecharge(orderId, customerPhone, paymentAmount, plan);
        } else {
            console.error(`Webhook: Stored order details not found for order ID ${orderId}, user ${customerPhone}. Cannot determine plan.`);
            // You might want to try to infer the plan or log this for manual review
            // For now, we'll proceed without yearly bonus if plan is unknown via webhook.
            await processSuccessfulRecharge(orderId, customerPhone, paymentAmount, null); // Pass null or a default plan
        }

    } catch (error) {
        console.error(`Webhook: Error fetching stored order details or processing recharge for ${orderId}:`, error);
        return res.status(500).send("Error processing webhook.");
    }
  } else if (eventType === 'PAYMENT_FAILED_WEBHOOK' && orderId && customerPhone) {
    console.log(`Webhook: Payment FAILED for Order ID ${orderId}. Marking as failed in DB.`);
    const orderRef = doc(db, `users/${customerPhone}/rechargesOrderIds/${orderId}`);
    await setDoc(orderRef, { status: 'FAILED', timestamp: serverTimestamp() }, { merge: true });
  }
  // You can handle other webhook event types (e.g., PAYMENT_PENDING_WEBHOOK, REFUND_SUCCESS_WEBHOOK) here

  res.status(200).send("OK");
});

// Test endpoint for Cashfree sample signature (retained for your reference)
app.get('/test-cashfree-sample-signature', (req, res) => {
  const webhooksignatureFromSample = 'EhW2Z+rTcC337M2hJMR4GxmivdwZIwyadTScjy33HEc=';
  const postDataFromSample = `{"data":{"order":{"order_id":"qwert59954432221","order_amount":1.00,"order_currency":"INR","order_tags":null},"payment":{"cf_payment_id":5114917039291,"payment_status":"SUCCESS","payment_amount":1.00,"payment_currency":"INR","payment_message":"Simulated response message","payment_time":"2025-03-28T18:59:39+05:30","bank_reference":"1234567890","auth_id":null,"payment_method":{"upi":{"channel":null,"upi_id":"testsuccess@gocash"}},"payment_group":"upi"},"customer_details":{"customer_name":null,"customer_id":"devstudio_user","customer_email":"test123@gmail.com","customer_phone":"8474090589"}},"event_time":"2025-03-28T19:00:02+05:30","type":"PAYMENT_SUCCESS_WEBHOOK"}`;
  const timestampFromSample = '1743168602521';
  const secretKeyForTesting = 'caj1ueti8zo6626xdbxi'; // Replace with a test secret if you have one, or just your actual one.

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
