const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema({
  webhook_url: { type: String, default: '' },
  api_key: { type: String, required: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Settings', SettingsSchema);