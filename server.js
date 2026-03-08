const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// --- 0. BOT WEBHOOK CONFIG (NOW DYNAMIC) ---
// We keep the original helper but update it to accept a dynamic URL
const sendToBot = async (jid, text, dynamicUrl) => {
    try {
        // Use the dynamicUrl passed from the callback, fallback to hardcoded if needed
        const targetUrl = dynamicUrl || "https://gggg-b9d7fbe20737.herokuapp.com";
        const webhookPath = `${targetUrl.replace(/\/$/, "")}/v_hub_notify`;

        await axios.post(webhookPath, { jid, text }, {
            headers: { 
                'x-vhub-secret': process.env.API_SECRET,
                'Content-Type': 'application/json'
            }
        });
        console.log(`┃ ✅ NOTIFY_SENT: Message pushed to Bot [${targetUrl}] for JID: ${jid}`);
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

// --- 2. SHARED DATABASE SCHEMA (FIXED: MPESA_ID NO LONGER REQUIRED) ---
const UserSchema = new mongoose.Schema({
    mpesa_id: { type: String }, // Removed required: true to stop 500 crashes
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

    const shortName = waName ? (waName.length > 12 ? waName.substring(0, 12) + ".." : waName) : "Unknown";

    try {
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

        if (withdrawAmount < 10) {
            return res.status(400).json({ error: "MINIMUM_WITHDRAW_10" });
        }

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

// --- 5. THE ULTIMATE CALLBACK (M-PESA 7-POINT DYNAMIC LISTENER) ---
app.post('/api/callback', async (req, res) => {
    try {
        const body = req.body.Body;
        let targetJid = req.query.jid; 
        let waName = req.query.name || "V_Hub Member";
        let vHubRefFromBot = req.query.ref; 
        
        // CAPTURE THE BOT'S OWN URL DYNAMICALLY FROM QUERY
        let botBaseUrl = req.query.callbackUrl; 

        if (targetJid) {
            await sendToBot(targetJid, "⏳ *ᴠ-ʜᴜʙ:* ᴘᴀʏᴍᴇɴᴛ ᴅᴇᴛᴇᴄᴛᴇᴅ. ᴜᴘᴅᴀᴛɪɴɢ ʏᴏᴜʀ ᴡᴀʟʟᴇᴛ, ᴘʟᴇᴀsᴇ ᴡᴀɪᴛ...", botBaseUrl);
        }

        if (body && body.stkCallback) {
            const callback = body.stkCallback;
            const resultCode = callback.ResultCode;
            const resultDesc = callback.ResultDesc;

            if (resultCode === 0) {
                const meta = callback.CallbackMetadata.Item;
                let extractedPhone, extractedAmount, extractedReceipt;
                
                meta.forEach(item => {
                    if (item.Name === "PhoneNumber") extractedPhone = item.Value.toString();
                    if (item.Name === "Amount") extractedAmount = item.Value;
                    if (item.Name === "MpesaReceiptNumber") extractedReceipt = item.Value;
                });

                const finalPhone = extractedPhone || meta[meta.length - 1].Value.toString();

                if (finalPhone) {
                    const internalRef = `VHB-${Math.floor(100000 + Math.random() * 900000)}`;
                    const vHubID_New = `VHB-${Math.floor(100000 + Math.random() * 900000)}`;
                    const dbName = waName.length > 12 ? waName.substring(0, 12) + ".." : waName;

                    let user = await User.findOne({ 
                        $or: [ { v_hub_id: vHubRefFromBot }, { mpesa_id: finalPhone } ] 
                    });

                    if (user) {
                        user.balance += extractedAmount;
                        user.history.push({ type: "DEPOSIT", amount: extractedAmount, receipt: extractedReceipt, v_hub_ref: internalRef });
                        await user.save();
                    } else {
                        user = await User.create({
                            mpesa_id: finalPhone,
                            v_hub_id: vHubRefFromBot || vHubID_New,
                            name: dbName,
                            balance: extractedAmount,
                            history: [{ type: "DEPOSIT", amount: extractedAmount, receipt: extractedReceipt, v_hub_ref: internalRef }]
                        });
                    }

                    const mpesaStyle = `*${extractedReceipt} Confirmed.* Ksh${extractedAmount}.00 received from ${finalPhone} on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}. New V-HUB balance is Ksh${user.balance}.`;
                    const vhubReceipt = `┏━━━━━ ✿ *ᴠ-ʜᴜʙ_ʀᴇᴄᴇɪᴘᴛ* ✿ ━━━━━┓\n┃\n┃ ✅ *ᴅᴇᴘᴏsɪᴛ sᴜᴄᴄᴇssꜰᴜʟ*\n┃ 👤 *ᴄᴜsᴛᴏᴍᴇʀ:* ${user.name}\n┃ 💵 *ᴀᴍᴏᴜɴᴛ:* ᴋsʜ ${extractedAmount}\n┃ 📅 *ᴛɪᴍᴇ:* ${new Date().toLocaleTimeString()}\n┃\n┣━━━━━━━━━━━━━━━━━━━━━━┫\n┃\n┃ 🏦 *ᴠ-ʜᴜʙ ʙᴀʟ:* ᴋsʜ ${user.balance}\n┃ 🆔 *ᴡᴀʟʟᴇᴛ ɪᴅ:* ${user.v_hub_id}\n┃ 📱 *ᴍ-ᴘᴇsᴀ ʀᴇꜰ:* ${extractedReceipt}\n┃\n┣━━━━━━━━━━━━━━━━━━━━━━┫\n┃ _ᴛʜᴀɴᴋ ʏᴏᴜ ꜰᴏʀ ʙᴀɴᴋɪɴɢ ᴡɪᴛʜ ᴜs_\n┗━━━━━━━━━━━━━━━━━━━━━━┛`;

                    if (targetJid) {
                        await sendToBot(targetJid, mpesaStyle, botBaseUrl);
                        await sendToBot(targetJid, vhubReceipt, botBaseUrl);
                    }
                }
            } else {
                let errorReason = "ᴛʀᴀɴsᴀᴄᴛɪᴏɴ ꜰᴀɪʟᴇᴅ";
                switch(resultCode) {
                    case 1: errorReason = "ɪɴsᴜꜰꜰɪᴄɪᴇɴᴛ ꜰᴜɴᴅs ɪɴ ᴍ-ᴘᴇsᴀ."; break;
                    case 1032: errorReason = "ʀᴇǫᴜᴇsᴛ ᴄᴀɴᴄᴇʟʟᴇᴅ ʙʏ ᴜsᴇʀ."; break;
                    case 2001: errorReason = "ᴡʀᴏɴɢ ᴍ-ᴘᴇsᴀ ᴘɪɴ ᴇɴᴛᴇʀᴇᴅ."; break;
                    case 1037: errorReason = "ᴅs_ᴛɪᴍᴇᴏᴜᴛ (ɴᴏ ʀᴇsᴘᴏɴsᴇ)."; break;
                    case 17: errorReason = "ᴇxᴄᴇᴇᴅᴇᴅ ᴅᴀɪʟʏ/ᴛx ʟɪᴍɪᴛ."; break;
                    case 1019: errorReason = "ᴛʀᴀɴsᴀᴄᴛɪᴏɴ ᴇxᴘɪʀᴇᴅ/ʙʟᴏᴄᴋᴇᴅ."; break;
                    default: errorReason = resultDesc;
                }
                const errorMsg = `┏━━━━━ ✿ *ᴠ-ʜᴜʙ_ᴀʟᴇʀᴛ* ✿ ━━━━━┓\n┃\n┃ ❌ *ᴛʀᴀɴsᴀᴄᴛɪᴏɴ ꜰᴀɪʟᴇᴅ*\n┃ 🆔 *ʀᴇꜰ:* ${vHubRefFromBot || 'ɢᴜᴇsᴛ'}\n┃\n┣━━━━━━━━━━━━━━━━━━━━━━┫\n┃\n┃ ⚠️ *ʀᴇᴀsᴏɴ:*\n┃ ${errorReason}\n┃\n┣━━━━━━━━━━━━━━━━━━━━━━┫\n┃ _ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ᴡɪᴛʜ ᴄᴏʀʀᴇᴄᴛ ɪɴꜰᴏ_\n┗━━━━━━━━━━━━━━━━━━━━━━┛`;
                if (targetJid) await sendToBot(targetJid, errorMsg, botBaseUrl);
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
    console.log(`┃  STAT: DYNAMIC_WEBHOOK_READY    ┃`);
    console.log(`┃  DB:   CONNECTED_TO_ATLAS       ┃`);
    console.log(`┗━━━━━ ✿ INFINITE_IMPACT ✿ ━━━━━┛`);
});
