const mongoose = require("mongoose");

const connectDB = async () => {
    try {
        const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/whatsapp_crm";
        await mongoose.connect(uri);

        console.log("🟢 MongoDB Connected Successfully");
        
        // Setup Event Listeners for Stability
        mongoose.connection.on('error', err => {
            console.error('🔴 MongoDB Error:', err);
        });

        mongoose.connection.on('disconnected', () => {
            console.warn('🟡 MongoDB Disconnected. Reconnecting...');
        });

    } catch (error) {
        console.error("🔴 DB Connection Error:", error.message);
        // Do not exit process, allow system to retry or function in limited mode
    }
};

module.exports = connectDB;
