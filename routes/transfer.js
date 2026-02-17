const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = mongoose.model('User');

router.post('/internal', async (req, res) => {
    const { senderPhone, receiverPhone, amount } = req.body;
    
    // 1. Start the Session
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        console.log(`┃ 🔄 ATOMIC_TRANSFER: ${senderPhone} ➔ ${receiverPhone} | KSH ${amount}`);

        // 2. Deduct from Sender (with check)
        const sender = await User.findOneAndUpdate(
            { mpesa_id: senderPhone, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            { session, new: true }
        );

        if (!sender) {
            throw new Error("INSUFFICIENT_FUNDS_OR_USER_NOT_FOUND");
        }

        // 3. Add to Receiver (Upsert enabled so we create shadow accounts)
        await User.findOneAndUpdate(
            { mpesa_id: receiverPhone },
            { $inc: { balance: amount } },
            { session, upsert: true }
        );

        // 4. Commit the changes (If we reach here, both succeeded)
        await session.commitTransaction();
        session.endSession();

        console.log(`┃ ✅ TRANSFER_COMPLETE: ${senderPhone} ➔ ${receiverPhone}`);
        res.json({ status: "SUCCESS", newBalance: sender.balance });

    } catch (error) {
        // 5. Rollback (If anything failed, undo everything)
        await session.abortTransaction();
        session.endSession();
        
        console.error(`┃ ❌ TRANSFER_FAILED: ${error.message}`);
        res.status(400).json({ status: "FAILED", msg: error.message });
    }
});

module.exports = router;