const { isValidPhoneNumber } = require('../utils/helpers');

function validateOtpRequest(req, res, next) {
  const { phone, message } = req.body;
  
  if (!phone || !message) {
    return res.status(400).json({ 
      error: 'Phone and message are required' 
    });
  }
  
  if (!isValidPhoneNumber(phone)) {
    return res.status(400).json({ 
      error: 'Invalid phone number format' 
    });
  }
  
  if (message.length > 1000) {
    return res.status(400).json({ 
      error: 'Message too long (max 1000 characters)' 
    });
  }
  
  next();
}

function validateSettingsRequest(req, res, next) {
  const { webhook_url } = req.body;
  
  if (webhook_url && !isValidUrl(webhook_url)) {
    return res.status(400).json({ 
      error: 'Invalid webhook URL format' 
    });
  }
  
  next();
}

function isValidUrl(string) {
  try {
    new URL(string);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  validateOtpRequest,
  validateSettingsRequest
};