const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// --- 1. DEEP LOGGING MIDDLEWARE ---
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
const UserSchema = new mongoose.Schema({
    mpesa_id: { type: String, required: true, unique: true },
    name: { type: String, default: "V_Hub Member" },
    balance: { type: Number, default: 0 },
    history: [{
        type: { type: String },
        amount: Number,
        receipt: String,
        v_hub_ref: String,
        date: { type: Date, default: Date.now }
    }]
});
const User = mongoose.model('User', UserSchema);

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

// --- 5. THE ULTIMATE CALLBACK (M-PESA LISTENER) ---
app.post('/api/callback', async (req, res) => {
    try {
        const body = req.body.Body;
        let mpesaData = null;
        let logMessage = "";

        if (body && body.stkCallback) {
            const callback = body.stkCallback;
            const resultCode = callback.ResultCode;

            if (resultCode === 0) {
                // --- SUCCESSFUL DEPOSIT ---
                const meta = callback.CallbackMetadata.Item;
                mpesaData = {
                    phone: meta.find(i => i.Name === "PhoneNumber").Value.toString(),
                    amount: meta.find(i => i.Name === "Amount").Value,
                    receipt: meta.find(i => i.Name === "MpesaReceiptNumber").Value,
                    type: "DEPOSIT"
                };
                logMessage = `✅ SUCCESS: Recieved KSH ${mpesaData.amount} from ${mpesaData.phone}`;
            } else {
                // --- DETAILED ERROR HANDLING ---
                let errorTitle = "❌ V_HUB: TRANSACTION FAILED";
                let errorDetail = "";

                switch (resultCode) {
                    case 1:
                        errorDetail = "Insufficient funds in your M-PESA account.";
                        break;
                    case 1032:
                        errorDetail = "Transaction cancelled by user.";
                        break;
                    case 2001:
                        errorDetail = "The M-PESA PIN entered was incorrect.";
                        break;
                    case 1037:
                        errorDetail = "Request timed out. You took too long to enter your PIN.";
                        break;
                    default:
                        errorDetail = callback.ResultDesc || "An unknown M-PESA error occurred.";
                }
                console.log(`┃ ⚠️  MPESA_DENIED: ${resultCode} - ${errorDetail}`);
                // Note: You can trigger a webhook here to notify the bot of the failure
            }
        } 
        else if (req.body.Result) {
            // --- B2C WITHDRAWAL HANDLING ---
            const result = req.body.Result;
            if (result.ResultCode === 0) {
                mpesaData = {
                    phone: result.ResultParameters.ResultParameter.find(i => i.Key === "ReceiverPartyPublicName").Value,
                    amount: result.ResultParameters.ResultParameter.find(i => i.Key === "TransactionAmount").Value,
                    receipt: result.MpesaReceiptNumber,
                    type: "WITHDRAW"
                };
                logMessage = `✅ WITHDRAW_SUCCESS: Disbursed KSH ${mpesaData.amount} to ${mpesaData.phone}`;
            }
        }

        // --- DATABASE UPDATE LOGIC ---
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

            console.log(`┃ ${logMessage}`);
            console.log(`┃ ✿ NEW_BALANCE: KSH ${user.balance}`);
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
