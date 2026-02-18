const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// --- 0. BOT WEBHOOK CONFIG (HARDCODED AS REQUESTED) ---
const BOT_URL = "https://gggg-b9d7fbe20737.herokuapp.com"; 
const BOT_WEBHOOK = `${BOT_URL}/v_hub_notify`;

// Helper to send styled responses back to WhatsApp
const sendToBot = async (jid, text) => {
    try {
        await axios.post(BOT_WEBHOOK, { jid, text }, {
            headers: { 
                'x-vhub-secret': process.env.API_SECRET,
                'Content-Type': 'application/json'
            }
        });
        console.log(`┃ ✅ NOTIFY_SENT: Message pushed to Bot for JID: ${jid}`);
    } catch (e) {
        console.error("┃ ❌ BOT_NOTIFY_FAILED:", e.response?.status || e.message);
    }
};

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

// --- 2. SHARED DATABASE SCHEMA (UPDATED WITH V_HUB_ID) ---
const UserSchema = new mongoose.Schema({
    mpesa_id: { type: String, required: true, unique: true },
    v_hub_id: { type: String, unique: true }, // New Account Number Field
    name: { type: String, default: "V_Hub Member" },
    balance: { type: Number, default: 0 },
    history: [{
        type: { type: String }, // DEPOSIT, WITHDRAW, SENT, RECEIVED
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

// --- UPDATED: OWNER DISBURSEMENT ROUTE (WITH WITHDRAWAL) ---
app.post('/api/withdraw', secureHandshake, async (req, res) => {
    const { phone, amount, waName } = req.body;
    const withdrawAmount = Number(amount);

    // Truncate name to 12 characters
    const shortName = waName ? (waName.length > 12 ? waName.substring(0, 12) + ".." : waName) : "Unknown";

    try {
        // --- SECURITY: PREVENT MISUSE (CHECK IF USER EXISTS) ---
        const user = await User.findOne({ mpesa_id: phone });
        if (!user) {
            console.log(`┃ ⚠️  SECURITY: Access Denied for unregistered user ${phone}`);
            return res.status(403).json({ error: "USER_NOT_IN_DATABASE" });
        }

        // --- VALIDATION: B2C MINIMUM ---
        if (withdrawAmount < 10) {
            return res.status(400).json({ error: "MINIMUM_WITHDRAW_10" });
        }

        // Trigger Safaricom B2C Logic (Requires disburse function in routes/withdraw)
        const b2c = require('./routes/withdraw');
        const result = await b2c.disburse(phone, withdrawAmount);

        if (result.success) {
            user.balance -= withdrawAmount;
            const internalRef = `VHW-${Math.floor(100000 + Math.random() * 900000)}`;
            
            user.history.push({
                type: "WITHDRAW",
                amount: withdrawAmount,
                receipt: result.ConversationID,
                v_hub_ref: internalRef
            });
            await user.save();

            res.json({ 
                success: true, 
                receipt: result.ConversationID, 
                newBalance: user.balance,
                shortName: shortName 
            });
        } else {
            res.status(400).json({ error: result.message || "B2C_FAILED" });
        }
    } catch (e) {
        console.error("┃ ❌ WITHDRAW_ROUTE_CRASH:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- NEW: INTERNAL PAY ROUTE (P2P WITH TARIFFS) ---
app.post('/api/pay', secureHandshake, async (req, res) => {
    const { sender_phone, receiver_id, amount } = req.body;
    const transferAmount = Number(amount);

    try {
        const sender = await User.findOne({ mpesa_id: sender_phone });
        const receiver = await User.findOne({ 
            $or: [{ mpesa_id: receiver_id }, { v_hub_id: receiver_id }] 
        });

        if (!sender || sender.balance < transferAmount) {
            return res.status(400).json({ error: "INSUFFICIENT_BALANCE" });
        }
        if (!receiver) {
            return res.status(404).json({ error: "RECEIVER_NOT_FOUND" });
        }

        let fee = 0;
        if (transferAmount > 100 && transferAmount <= 500) fee = 7;
        else if (transferAmount > 500 && transferAmount <= 1000) fee = 13;
        else if (transferAmount > 1000) fee = 23;

        const totalDeduction = transferAmount + fee;

        if (sender.balance < totalDeduction) {
            return res.status(400).json({ error: "INSUFFICIENT_FOR_FEE", fee });
        }

        const v_ref = `VHP-${Math.floor(100000 + Math.random() * 900000)}`;

        sender.balance -= totalDeduction;
        receiver.balance += transferAmount;

        sender.history.push({ type: "SENT", amount: transferAmount, v_hub_ref: v_ref, receipt: `To: ${receiver.v_hub_id || receiver.mpesa_id}` });
        receiver.history.push({ type: "RECEIVED", amount: transferAmount, v_hub_ref: v_ref, receipt: `From: ${sender.v_hub_id || sender.mpesa_id}` });

        await sender.save();
        await receiver.save();

        res.json({ success: true, fee, newBalance: sender.balance, v_ref, receiverName: receiver.name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- NEW: POLLING ROUTE FOR WORKER BOTS ---
app.get('/api/check-status', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: "Phone number is required" });

    try {
        const user = await User.findOne({ mpesa_id: phone });
        if (!user || !user.history || user.history.length === 0) {
            return res.status(404).json({ status: "NOT_FOUND" });
        }

        const lastTx = user.history[user.history.length - 1];
        const isRecent = (new Date() - new Date(lastTx.date)) < 180000;

        res.json({ 
            status: "OK", 
            isRecent,
            balance: user.balance, 
            lastTransaction: lastTx,
            v_hub_id: user.v_hub_id 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 5. THE ULTIMATE CALLBACK (M-PESA LISTENER) ---
app.post('/api/callback', async (req, res) => {
    try {
        const body = req.body.Body;
        let mpesaData = null;
        let logMessage = "";
        let finalStatusMessage = "";
        let targetJid = req.query.jid; 

        if (body && body.stkCallback) {
            const callback = body.stkCallback;
            const resultCode = callback.ResultCode;

            if (resultCode === 0) {
                const meta = callback.CallbackMetadata.Item;
                mpesaData = {
                    phone: meta.find(i => i.Name === "PhoneNumber").Value.toString(),
                    amount: meta.find(i => i.Name === "Amount").Value,
                    receipt: meta.find(i => i.Name === "MpesaReceiptNumber").Value,
                    type: "DEPOSIT"
                };
                logMessage = `✅ SUCCESS: Recieved KSH ${mpesaData.amount} from ${mpesaData.phone}`;
                finalStatusMessage = `┏━━━━━ ✿ *V_HUB_RECEIPT* ✿ ━━━━━┓\n┃\n┃ ✅ *DEPOSIT CONFIRMED*\n┃ 💵 *AMOUNT:* KSH ${mpesaData.amount}\n┃ 🧾 *REF:* ${mpesaData.receipt}\n┃ 🏦 *BANK:* M-PESA\n┃\n┃ _Your V_Hub balance has been updated._\n┗━━━━━━━━━━━━━━━━━━━━━━┛`;
            } else {
                let errorDetail = "";
                switch (resultCode) {
                    case 1: errorDetail = "Insufficient funds in your M-PESA account."; break;
                    case 1032: errorDetail = "Transaction cancelled by user."; break;
                    case 2001: errorDetail = "The M-PESA PIN entered was incorrect."; break;
                    case 1037: errorDetail = "Request timed out. You took too long."; break;
                    default: errorDetail = callback.ResultDesc || "M-PESA error.";
                }
                finalStatusMessage = `┏━━━━━ ✿ *V_HUB_ALERT* ✿ ━━━━━┓\n┃\n┃ ❌ *PAYMENT FAILED*\n┃ ⚠️ *REASON:* ${errorDetail}\n┃\n┃ _Please try again with the correct PIN._\n┗━━━━━━━━━━━━━━━━━━━━━━┛`;
            }
        } 

        if (mpesaData) {
            const updateAmount = mpesaData.type === "DEPOSIT" ? mpesaData.amount : -mpesaData.amount;
            const internalRef = `VHB-${Math.floor(100000 + Math.random() * 900000)}`;
            const vHubID = `VHB-${Math.floor(100000 + Math.random() * 900000)}`;

            const user = await User.findOneAndUpdate(
                { mpesa_id: mpesaData.phone },
                { 
                    $setOnInsert: { v_hub_id: vHubID },
                    $inc: { balance: updateAmount },
                    $push: { history: { type: mpesaData.type, amount: mpesaData.amount, receipt: mpesaData.receipt, v_hub_ref: internalRef } }
                },
                { upsert: true, new: true }
            );
            console.log(`┃ ${logMessage} | New Bal: ${user.balance}`);
        }

        if (targetJid && finalStatusMessage) {
            await sendToBot(targetJid, finalStatusMessage);
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
