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
  doc
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

const performDailyDeduction = async () => {
  try {
    console.log('Starting daily balance deduction process...', new Date().toISOString());
    
    const vendorsCol = collection(db, 'users');
    const vendorsSnapshot = await getDocs(vendorsCol);
    const deductionAmount = 12;
    
    const batch = writeBatch(db);
    let processedCount = 0;

    vendorsSnapshot.forEach((vendorDoc) => {
      const vendorData = vendorDoc.data();
      const currentBalance = vendorData.balance || 0;
      
      if (currentBalance >= deductionAmount) {
        const newBalance = currentBalance - deductionAmount;
        batch.update(vendorDoc.ref, {
          balance: newBalance,
          lastDeduction: serverTimestamp()
        });
        processedCount++;
        
        const deductionsCol = collection(db, `users/${vendorDoc.id}/deductions`);
        const deductionRef = doc(deductionsCol);
        batch.set(deductionRef, {
          amount: deductionAmount,
          previousBalance: currentBalance,
          newBalance: newBalance,
          timestamp: serverTimestamp(),
          type: 'daily_charge'
        });
      }
    });

    await batch.commit();
    console.log(`Completed: Deducted ₹4 from ${processedCount} vendors`, new Date().toISOString());
  } catch (error) {
    console.error('Deduction failed:', error, new Date().toISOString());
  }
};

// Schedule daily deduction
cron.schedule('0 0 * * *', performDailyDeduction, {
  scheduled: true,
  timezone: "Asia/Kolkata"
});

// Manual trigger endpoint
const manualTrigger = () => {
  console.log('Manually triggering deduction...');
  performDailyDeduction();
};

// Cashfree configuration
Cashfree.XClientId = process.env.CLIENT_ID;
Cashfree.XClientSecret = process.env.CLIENT_SECRET;
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION; // Changed to PRODUCTION


// Create payment order endpoint
app.post('/create-order', async (req, res) => {
  try {
    const { plan, amount, planDetails, mobileNumber, shopName, orderId } = req.body;
    
    if (!plan || !amount || !planDetails || !mobileNumber || !shopName || !orderId) {
      return res.status(400).json({ error: "Plan and amount are required" });
    }

    const request = {
      order_amount: amount,
      order_currency: "INR",
      order_id: orderId,
      customer_details: {
        customer_id: shopName,
        customer_phone: mobileNumber
      },
      order_meta: {
        return_url: req.body.return_url || `https://unoshops.com/?rechargeModalVisible=true&orderId=${orderId}`,
        plan_details: planDetails
      }
    };

    const response = await Cashfree.PGCreateOrder("2023-08-01", request);
    
    // Save this order to database in production
    console.log(`Created order for ${plan} plan: ${request.order_id}`);
    
    res.json({
      payment_session_id: response.data.payment_session_id,
      order_id: request.order_id,
      payment_link: response.data.payment_link,
      plan: plan,
      amount: amount
    });

  } catch (error) {
    console.error("Order creation error:", error);
    res.status(500).json({ 
      error: error.response?.data?.message || "Failed to create order" 
    });
  }
});

// Verify payment endpoint
app.post('/verify', async (req, res) => {
  try {
    const { orderId } = req.body;
    
    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    const response = await Cashfree.PGOrderFetchPayments("2023-08-01", orderId);
    
    if (!response.data || response.data.length === 0) {
      return res.status(404).json({ error: "No payment details found for this order" });
    }

    const paymentDetails = response.data[0];
    const paymentStatus = paymentDetails.payment_status;
    const isSuccess = paymentStatus === "SUCCESS";
    
    res.json({
      status: paymentStatus,
      order_id: orderId,
      is_success: isSuccess,
      payment_status: paymentStatus,
      payment_method: paymentDetails.payment_method,
      payment_time: paymentDetails.payment_time,
      payment_details: paymentDetails
    });

  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({ 
      error: error.response?.data?.message || "Failed to verify payment" 
    });
  }
});

app.post('/trigger-deduction', async (req, res) => {
  try {
    manualTrigger();
    res.json({ success: true, message: 'Deduction process triggered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 9123;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Daily deduction scheduler is active perfectly');
});
