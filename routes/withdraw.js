const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getMpesaToken } = require('../utils/mpesaAuth');

router.post('/disburse', async (req, res) => {
    const { phone, amount } = req.body;
    const token = await getMpesaToken();

    console.log(`┃ 💸 INITIATING_B2C: ${phone} | KSH ${amount}`);

    try {
        const response = await axios.post("https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest", {
            InitiatorName: process.env.MPESA_INITIATOR_NAME,
            SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
            CommandID: "BusinessPayment",
            Amount: amount, PartyA: process.env.MPESA_SHORTCODE,
            PartyB: phone, Remarks: "V_Hub Payout",
            QueueTimeOutURL: process.env.MPESA_CALLBACK_URL,
            ResultURL: process.env.MPESA_CALLBACK_URL,
            Occasion: "Withdrawal"
        }, { headers: { Authorization: `Bearer ${token}` } });

        res.json({ status: "SUCCESS", data: response.data });
    } catch (e) {
        console.error("┃ ❌ B2C_ERR:", e.response?.data || e.message);
        res.status(500).json({ error: "B2C Failed" });
    }
});

module.exports = router;