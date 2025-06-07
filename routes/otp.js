const express = require('express');
const router = express.Router();
const Log = require('../models/Log');
const Settings = require('../models/Settings');
const { validateApiKey } = require('../middleware/auth');
const { validateOtpRequest } = require('../middleware/validation');
const { sendMessage } = require('../services/whatsapp');
const { sendWebhook } = require('../services/webhook');
const { generateId, formatPhoneNumber } = require('../utils/helpers');

// POST /api/send-otp
router.post('/send-otp', validateOtpRequest, validateApiKey, async (req, res) => {
  try {
    const { phone, message } = req.body;
    const formattedPhone = formatPhoneNumber(phone);
    const logId = generateId();
    
    // Create log entry
    const log = new Log({
      id: logId,
      phone: formattedPhone,
      message: message,
      status: 'pending'
    });
    await log.save();
    
    // Send WhatsApp message
    const result = await sendMessage(formattedPhone, message);
    
    // Update log status
    log.status = result.success ? 'success' : 'failed';
    log.error_message = result.success ? null : result.error;
    log.updated_at = new Date();
    await log.save();
    
    // Send webhook notification
    const settings = await Settings.findOne();
    if (settings?.webhook_url) {
      await sendWebhook(settings.webhook_url, {
        id: logId,
        phone: formattedPhone,
        status: log.status,
        timestamp: log.updated_at.toISOString(),
        error_message: log.error_message
      });
    }
    
    res.json({
      id: logId,
      status: log.status,
      message: result.success ? 'OTP sent successfully' : 'Failed to send OTP',
      error: result.error || null
    });
    
  } catch (error) {
    console.error('❌ Error in send-otp:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;