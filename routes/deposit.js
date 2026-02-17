const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getMpesaToken } = require('../utils/mpesaAuth');

router.post('/prompt', async (req, res) => {
    // Added 'jid' to the request body coming from your bot
    const { phone, amount, jid } = req.body; 
    const token = await getMpesaToken();
    const date = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${date}`).toString('base64');

    // Logic: Clean JID for Safaricom (Max 12 chars). Fallback to 'Vinnie_Hub'
    const cleanReference = jid ? jid.split('@')[0].substring(0, 12) : "Vinnie_Hub";

    console.log(`┃ ⚡ INITIATING_STK: ${phone} | REF: ${cleanReference}`);

    try {
        const response = await axios.post("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
            BusinessShortCode: process.env.MPESA_SHORTCODE,
            Password: password, 
            Timestamp: date,
            TransactionType: "CustomerPayBillOnline", 
            Amount: amount, 
            PartyA: phone, 
            PartyB: process.env.MPESA_SHORTCODE,
            PhoneNumber: phone, 
            CallBackURL: process.env.MPESA_CALLBACK_URL,
            // Dynamic Reference based on user JID
            AccountReference: cleanReference, 
            TransactionDesc: `Wallet Deposit for ${cleanReference}`
        }, { headers: { Authorization: `Bearer ${token}` } });

        console.log(`┃ ✅ STK_SENT: ${phone} | REF: ${cleanReference}`);
        res.json({ status: "PENDING", data: response.data });
    } catch (e) {
        console.error("┃ ❌ STK_ERR:", e.response?.data || e.message);
        res.status(500).json({ error: "STK Push Failed" });
    }
});

module.exports = router;