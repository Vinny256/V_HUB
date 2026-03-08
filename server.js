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

    // Truncate name to 12 characters for v_hub consistency
    const shortName = waName ? (waName.length > 12 ? waName.substring(0, 12) + ".." : waName) : "Unknown";

    try {
        // --- SECURITY: PREVENT MISUSE (SMART SEARCH) ---
        const user = await User.findOne({ 
            $or: [
                { mpesa_id: phone }, 
                { v_hub_id: new RegExp(`^${phone}$`, 'i') }, 
                { name: new RegExp(`^${phone}$`, 'i') }
            ] 
        });

        if (!user) {
            console.log(`┃ ⚠️  SECURITY: Access Denied for unknown user [${phone}]`);
            return res.status(403).json({ error: "USER_NOT_IN_DATABASE" });
        }

        // --- VALIDATION: B2C MINIMUM ---
        if (withdrawAmount < 10) {
            return res.status(400).json({ error: "MINIMUM_WITHDRAW_10" });
        }

        // Trigger Safaricom B2C Logic
        const b2c = require('./routes/withdraw');
        const result = await b2c.disburse(user.mpesa_id, withdrawAmount);

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
                shortName: user.name 
            });
        } else {
            res.status(400).json({ error: result.message || "B2C_FAILED" });
        }
    } catch (e) {
        console.error("┃ ❌ WITHDRAW_ROUTE_CRASH:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- INTERNAL PAY ROUTE (P2P WITH TARIFFS) ---
app.post('/api/pay', secureHandshake, async (req, res) => {
    const { sender_phone, receiver_id, amount } = req.body;
    const transferAmount = Number(amount);

    try {
        const sender = await User.findOne({ mpesa_id: sender_phone });
        const receiver = await User.findOne({ 
            $or: [{ mpesa_id: receiver_id }, { v_hub_id: new RegExp(`^${receiver_id}$`, 'i') }] 
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

// --- UPDATED: SMART SEARCH POLLING ROUTE ---
app.get('/api/check-status', async (req, res) => {
    const { phone } = req.query; // Query can be Phone, Name, or ID
    if (!phone) return res.status(400).json({ error: "Parameter required" });

    console.log(`┃ 🔍 SMART_SEARCH: Querying [${phone}]`);

    try {
        const user = await User.findOne({ 
            $or: [
                { mpesa_id: phone }, 
                { v_hub_id: new RegExp(`^${phone}$`, 'i') }, 
                { name: new RegExp(`^${phone}$`, 'i') }
            ] 
        });

        if (!user) {
            return res.status(404).json({ status: "NOT_FOUND" });
        }

        const lastTx = user.history.length > 0 ? user.history[user.history.length - 1] : { date: new Date(0) };
        const isRecent = (new Date() - new Date(lastTx.date)) < 180000;

        res.json({ 
            status: "OK", 
            isRecent,
            balance: user.balance, 
            lastTransaction: lastTx,
            v_hub_id: user.v_hub_id,
            mpesa_id: user.mpesa_id,
            name: user.name
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 5. THE ULTIMATE CALLBACK (M-PESA LISTENER + ERROR HANDLING) ---
app.post('/api/callback', async (req, res) => {
    try {
        const body = req.body.Body;
        let mpesaData = null;
        let targetJid = req.query.jid; 
        let waName = req.query.name || "V_Hub Member";
        let vHubRefFromBot = req.query.ref; 

        if (body && body.stkCallback) {
            const callback = body.stkCallback;
            const resultCode = callback.ResultCode;
            const resultDesc = callback.ResultDesc;

            // --- CASE A: SUCCESS (ResultCode 0) ---
            if (resultCode === 0) {
                const meta = callback.CallbackMetadata.Item;
                const rawPhone = meta.find(i => i.Name === "PhoneNumber").Value;
                
                mpesaData = {
                    phone: rawPhone ? rawPhone.toString() : null,
                    amount: meta.find(i => i.Name === "Amount").Value,
                    receipt: meta.find(i => i.Name === "MpesaReceiptNumber").Value,
                    type: "DEPOSIT"
                };

                if (mpesaData.phone) {
                    const internalRef = `VHB-${Math.floor(100000 + Math.random() * 900000)}`;
                    const vHubID_New = `VHB-${Math.floor(100000 + Math.random() * 900000)}`;
                    const dbName = waName.length > 12 ? waName.substring(0, 12) + ".." : waName;

                    let user = await User.findOne({ 
                        $or: [ { v_hub_id: vHubRefFromBot }, { mpesa_id: mpesaData.phone } ] 
                    });

                    if (user) {
                        user.balance += mpesaData.amount;
                        user.history.push({ 
                            type: mpesaData.type, amount: mpesaData.amount, receipt: mpesaData.receipt, v_hub_ref: internalRef 
                        });
                        await user.save();
                    } else {
                        user = await User.create({
                            mpesa_id: mpesaData.phone,
                            v_hub_id: vHubRefFromBot || vHubID_New,
                            name: dbName,
                            balance: mpesaData.amount,
                            history: [{ type: mpesaData.type, amount: mpesaData.amount, receipt: mpesaData.receipt, v_hub_ref: internalRef }]
                        });
                    }

                    console.log(`┃ ✅ DB_UPDATED: ${user.name} | New Bal: ${user.balance}`);

                    const successMsg = `┏━━━━━ ✿ *ᴠ-ʜᴜʙ_ʀᴇᴄᴇɪᴘᴛ* ✿ ━━━━━┓\n┃\n┃ ✅ *ᴅᴇᴘᴏsɪᴛ sᴜᴄᴄᴇssꜰᴜʟ*\n┃ 👤 *ᴄᴜsᴛᴏᴍᴇʀ:* ${user.name}\n┃ 💵 *ᴀᴍᴏᴜɴᴛ:* ᴋsʜ ${mpesaData.amount}\n┃ 📅 *ᴛɪᴍᴇ:* ${new Date().toLocaleTimeString()}\n┃\n┣━━━━━━━━━━━━━━━━━━━━━━┫\n┃\n┃ 🏦 *ᴠ-ʜᴜʙ ʙᴀʟ:* ᴋsʜ ${user.balance}\n┃ 🆔 *ᴡᴀʟʟᴇᴛ ɪᴅ:* ${user.v_hub_id}\n┃ 📱 *ᴍ-ᴘᴇsᴀ ʀᴇꜰ:* ${mpesaData.receipt}\n┃\n┣━━━━━━━━━━━━━━━━━━━━━━┫\n┃ _ᴛʜᴀɴᴋ ʏᴏᴜ ꜰᴏʀ ʙᴀɴᴋɪɴɢ ᴡɪᴛʜ ᴜs_\n┗━━━━━━━━━━━━━━━━━━━━━━┛`;
                    if (targetJid) await sendToBot(targetJid, successMsg);
                }
            } 
            // --- CASE B: ERRORS (Wrong PIN, Cancelled, Insufficient Funds) ---
            else {
                let errorTitle = "ᴛʀᴀɴsᴀᴄᴛɪᴏɴ ꜰᴀɪʟᴇᴅ";
                let errorReason = resultDesc;

                if (resultCode === 1) errorReason = "ɪɴsᴜꜰꜰɪᴄɪᴇɴᴛ ʙᴀʟᴀɴᴄᴇ ɪɴ ᴍ-ᴘᴇsᴀ.";
                if (resultCode === 1032) errorReason = "ʀᴇǫᴜᴇsᴛ ᴄᴀɴᴄᴇʟʟᴇᴅ ʙʏ ᴜsᴇʀ.";
                if (resultCode === 2001) errorReason = "ᴡʀᴏɴɢ ᴍ-ᴘᴇsᴀ ᴘɪɴ ᴇɴᴛᴇʀᴇᴅ.";
                if (resultCode === 1037) errorReason = "ᴅsʟ ᴛɪᴍᴇᴏᴜᴛ (ɴᴏ ʀᴇsᴘᴏɴsᴇ).";

                const errorMsg = `┏━━━━━ ✿ *ᴠ-ʜᴜʙ_ᴀʟᴇʀᴛ* ✿ ━━━━━┓\n┃\n┃ ❌ *${errorTitle}*\n┃ 🆔 *ʀᴇꜰ:* ${vHubRefFromBot || 'ɢᴜᴇsᴛ'}\n┃\n┣━━━━━━━━━━━━━━━━━━━━━━┫\n┃\n┃ ⚠️ *ʀᴇᴀsᴏɴ:*\n┃ ${errorReason}\n┃\n┣━━━━━━━━━━━━━━━━━━━━━━┫\n┃ _ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ᴡɪᴛʜ ᴄᴏʀʀᴇᴄᴛ ɪɴꜰᴏ_\n┗━━━━━━━━━━━━━━━━━━━━━━┛`;
                
                console.log(`┃ ❌ MPESA_ERROR: ${resultCode} | ${resultDesc}`);
                if (targetJid) await sendToBot(targetJid, errorMsg);
            }
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
