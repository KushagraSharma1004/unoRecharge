const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Cashfree } = require('cashfree-pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Cashfree configuration
Cashfree.XClientId = process.env.CLIENT_ID;
Cashfree.XClientSecret = process.env.CLIENT_SECRET;
Cashfree.XEnvironment = Cashfree.Environment.PRODUCTION; // Changed to PRODUCTION

// Generate order ID
// function generateOrderId() {
//   return `UNO${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
// }

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
    
    // Extract UTR from payment method object
    const utr = paymentDetails.payment_method?.utr || 
                paymentDetails.payment_method?.upi?.utr || 
                paymentDetails.payment_method?.netbanking?.utr ||
                paymentDetails.payment_method?.card?.rrn;

    // In production:
    // 1. Update your database with payment status and UTR
    // 2. Activate the user's plan
    // 3. Send confirmation email
    
    res.json({
      status: paymentStatus,
      order_id: orderId,
      is_success: isSuccess,
      utr: utr, // Include UTR in response
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

const PORT = process.env.PORT || 9123;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
