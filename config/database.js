const mongoose = require('mongoose');

async function connectDatabase() {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/wa-otp-gateway';
    await mongoose.connect(uri);
    console.log('✅ MongoDB connected successfully');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    throw error;
  }
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
    console.log('MongoDB disconnected');
  }
}

module.exports = { connectDatabase, disconnectDatabase };