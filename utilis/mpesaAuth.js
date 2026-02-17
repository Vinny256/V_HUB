const axios = require('axios');

const getMpesaToken = async () => {
    const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
    try {
        const res = await axios.get("https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", {
            headers: { Authorization: `Basic ${auth}` }
        });
        return res.data.access_token;
    } catch (e) {
        console.error("┃ ❌ DARAJA_AUTH_ERROR:", e.response?.data || e.message);
        return null;
    }
};

module.exports = { getMpesaToken };