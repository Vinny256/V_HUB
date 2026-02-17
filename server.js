const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// --- 1. DEEP LOGGING MIDDLEWARE ---
// This ensures you see exactly what the bot and M-PESA are doing in real-time.
app.use((req, res, next) => {
    const start = Date.now();
    console.log(`\n┏━━━━━ ✿ INCOMING_REQUEST ✿ ━━━━━┓`);
    console.log(`┃  TIME: ${new Date().toLocaleTimeString()}`);
    console.log(`┃  PATH: ${req.path}`);
    console.log(`┃  BODY: ${JSON.stringify(req.body)}`);
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`┃  STAT: ${res.statusCode}`);
        console.log(`┃  DUR:  ${duration}ms`);
        console.log(`┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛`);
    });
    next();
});

// --- 2. SHARED DATABASE SCHEMA ---
// This is the "Brain" shared between your Bot and this Proxy.
const UserSchema = new mongoose.Schema({
    mpesa_id: { type: String, required: true, unique: true }, // The 254... number
    name: { type: String, default: "V_Hub Member" },
    balance: { type: Number, default: 0 },
    history: [{
        type: { type: String }, // DEPOSIT or WITHDRAW
        amount: Number,
        receipt: String,
        v_hub_ref: String,
        date: { type: Date, default: Date.now }
    }]
});
const User = mongoose.model('User', UserSchema);

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("┃ ✿ DATABASE: ATTACHED & READY"))
    .catch(err => console.error("┃ ❌ DB_ERROR:", err));

// --- 3. SECURITY HANDSHAKE ---
const secureHandshake = (req, res, next) => {
    if (req.headers['x-vhub-secret'] !== process.env.API_SECRET) {
        console.log("┃ ⚠️  SECURITY: INVALID HANDSHAKE DETECTED");
        return res.sendStatus(403);
    }
    next();
};

// --- 4. ROUTES ---
app.use('/api/deposit', secureHandshake, require('./routes/deposit'));
app.use('/api/withdraw', secureHandshake, require('./routes/withdraw'));
// Optional: app.use('/api/transfer', secureHandshake, require('./routes/transfer'));

// --- 5. THE ULTIMATE CALLBACK (M-PESA LISTENER) ---
// This captures real money and updates the Shared DB.
app.post('/api/callback', async (req, res) => {
    try {
        const body = req.body.Body;
        let mpesaData = null;

        // A. Handling STK Push (Deposits)
        if (body && body.stkCallback) {
            const callback = body.stkCallback;
            if (callback.ResultCode === 0) {
                const meta = callback.CallbackMetadata.Item;
                mpesaData = {
                    phone: meta.find(i => i.Name === "PhoneNumber").Value.toString(),
                    amount: meta.find(i => i.Name === "Amount").Value,
                    receipt: meta.find(i => i.Name === "MpesaReceiptNumber").Value,
                    type: "DEPOSIT"
                };
            }
        } 
        // B. Handling B2C (Withdrawals)
        else if (req.body.Result) {
            const result = req.body.Result;
            if (result.ResultCode === 0) {
                // For B2C, we map based on the PartyB or original conversation context
                mpesaData = {
                    phone: result.ResultParameters.ResultParameter.find(i => i.Key === "ReceiverPartyPublicName").Value, // Or use a ref tracker
                    amount: result.ResultParameters.ResultParameter.find(i => i.Key === "TransactionAmount").Value,
                    receipt: result.MpesaReceiptNumber,
                    type: "WITHDRAW"
                };
            }
        }

        if (mpesaData) {
            const updateAmount = mpesaData.type === "DEPOSIT" ? mpesaData.amount : -mpesaData.amount;
            const internalRef = `VHB-${Math.floor(100000 + Math.random() * 900000)}`;

            const user = await User.findOneAndUpdate(
                { mpesa_id: mpesaData.phone },
                { 
                    $inc: { balance: updateAmount },
                    $push: { 
                        history: { 
                            type: mpesaData.type, 
                            amount: mpesaData.amount, 
                            receipt: mpesaData.receipt, 
                            v_hub_ref: internalRef 
                        } 
                    }
                },
                { upsert: true, new: true }
            );

            console.log(`┃ ✅ SYNC_COMPLETE: ${user.mpesa_id} | New Bal: ${user.balance}`);
        }

        res.json({ ResultCode: 0, ResultDesc: "Accepted" });

    } catch (error) {
        console.error("┃ ❌ CALLBACK_CRASH:", error.message);
        res.status(500).json({ ResultCode: 1 });
    }
});

// --- 6. START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n┏━━━━━ ✿ V_HUB_PROXY_LIVE ✿ ━━━━━┓`);
    console.log(`┃  PORT: ${PORT}                      ┃`);
    console.log(`┃  STAT: DEEP_LOGGING_ACTIVE      ┃`);
    console.log(`┃  DB:   CONNECTED_TO_ATLAS       ┃`);
    console.log(`┗━━━━━ ✿ INFINITE_IMPACT ✿ ━━━━━┛`);
});