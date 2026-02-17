const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getMpesaToken } = require('../utils/mpesaAuth');

router.post('/prompt', async (req, res) => {
    // Now accepting waName from the bot
    const { phone, amount, jid, waName } = req.body; 
    
    const token = await getMpesaToken();
    const date = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${date}`).toString('base64');

    // --- 1. IDENTITY LOGIC ---
    // Priority: WhatsApp Name > JID > Default "V_Hub_Member"
    // Note: Safaricom limits AccountReference to 12 characters.
    const rawRef = waName || (jid ? jid.split('@')[0] : "V_Hub_Member");
    const cleanReference = rawRef.replace(/[^a-zA-Z0-9]/g, '').substring(0, 12);

    console.log(`┃ ⚡ INITIATING_STK: ${phone} | USER: ${cleanReference}`);

    // --- 2. CALLBACK ENHANCEMENT ---
    // We attach the jid as a query param so the /callback route knows who to notify
    const dynamicCallback = `${process.env.MPESA_CALLBACK_URL}?jid=${encodeURIComponent(jid)}&name=${encodeURIComponent(waName)}`;

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
            CallBackURL: dynamicCallback, // Pass JID to the listener
            AccountReference: cleanReference, 
            TransactionDesc: `Deposit for ${cleanReference}`
        }, { headers: { Authorization: `Bearer ${token}` } });

        console.log(`┃ ✅ STK_SENT: ${phone} | REF: ${cleanReference}`);
        
        // Return structured response for the bot's 'prompt.js'
        res.json({ 
            success: true, 
            ResponseCode: "0", 
            CustomerMessage: response.data.CustomerMessage 
        });

    } catch (e) {
        console.error("┃ ❌ STK_ERR:", e.response?.data || e.message);
        res.status(500).json({ success: false, error: "STK Push Failed" });
    }
});

module.exports = router;
