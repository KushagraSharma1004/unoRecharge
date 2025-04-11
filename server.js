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
function generateOrderId() {
  return `UNO${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
}

// Create payment order endpoint
app.post('/create-order', async (req, res) => {
  try {
    const { plan, amount, planDetails } = req.body;
    
    if (!plan || !amount) {
      return res.status(400).json({ error: "Plan and amount are required" });
    }

    const request = {
      order_amount: amount,
      order_currency: "INR",
      order_id: generateOrderId(),
      customer_details: {
        customer_id: `customer_${crypto.randomBytes(4).toString('hex')}`,
        customer_phone: "9999999999", // Get from auth in production
        customer_name: "Unoshops Customer",
        customer_email: "customer@unoshops.com"
      },
      order_meta: {
        return_url: req.body.return_url || "https://unoshops.com/payment-return",
        plan_details: planDetails // Storing plan details in metadata
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
    
    // In production:
    // 1. Update your database with payment status
    // 2. Activate the user's plan
    // 3. Send confirmation email
    
    res.json({
      status: "SUCCESS",
      order_id: orderId,
      payment_status: response.data[0]?.payment_status,
      payment_details: response.data
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