const crypto = require('crypto');

function generateId() {
  return 'TX' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

function generateApiKey() {
  return 'sk_' + crypto.randomBytes(16).toString('hex');
}

function formatPhoneNumber(phone) {
  // Remove all non-digits
  const cleaned = phone.replace(/\D/g, '');
  
  // Add 62 prefix if not present (Indonesia default)
  if (!cleaned.startsWith('62') && cleaned.length > 5) {
    console.warn(`Phone ${phone} doesn't start with 62. Please verify.`);
  }
  
  return cleaned;
}

function isValidPhoneNumber(phone) {
  const cleaned = phone.replace(/\D/g, '');
  return cleaned.length >= 10 && cleaned.length <= 15;
}

module.exports = {
  generateId,
  generateApiKey,
  formatPhoneNumber,
  isValidPhoneNumber
};