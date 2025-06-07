const express = require('express');
const router = express.Router();
const { getStatus, disconnect, refreshQR } = require('../services/whatsapp');

// GET /api/whatsapp/status
router.get('/status', (req, res) => {
  const status = getStatus();
  res.json({
    connected: status.connected,
    phone_number: status.phone_number,
    qr_available: status.qr_available
  });
});

// GET /api/whatsapp/qrcode
router.get('/qrcode', (req, res) => {
  const status = getStatus();
  
  if (status.qrcode) {
    res.json({ qrcode: status.qrcode });
  } else if (status.connected) {
    res.status(400).json({ error: 'WhatsApp is already connected' });
  } else {
    res.status(404).json({ error: 'QR code not available' });
  }
});

// POST /api/whatsapp/disconnect
router.post('/disconnect', async (req, res) => {
  try {
    const result = await disconnect();
    
    if (result.success) {
      res.json({ message: 'WhatsApp disconnected successfully' });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/whatsapp/refresh-qrcode
router.post('/refresh-qrcode', async (req, res) => {
  try {
    const status = getStatus();
    
    if (status.connected) {
      return res.status(400).json({ error: 'WhatsApp is already connected' });
    }
    
    const result = await refreshQR();
    
    if (result.success) {
      res.json({ message: 'QR code refresh initiated' });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;