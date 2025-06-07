const mongoose = require('mongoose');

const LogSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  message: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['success', 'failed', 'pending'], 
    default: 'pending' 
  },
  error_message: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Indexes for better performance
LogSchema.index({ created_at: -1 });
LogSchema.index({ status: 1 });
LogSchema.index({ phone: 1 });

module.exports = mongoose.model('Log', LogSchema);