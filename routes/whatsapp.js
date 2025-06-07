const express = require('express');
const router = express.Router();
const { getStatus, disconnect, refreshQR, getDeviceInfo, getLoginHistory, saveLoginHistory, initializeWhatsApp } = require('../services/whatsapp');

// POST /api/whatsapp/initialize - Initialize WhatsApp connection
router.post('/initialize', async (req, res) => {
  try {
    const clientIP = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');
    
    const result = await initializeWhatsApp();
    
    // Log initialization activity
    if (saveLoginHistory) {
      await saveLoginHistory({
        action: 'initialize',
        success: result.success,
        ip_address: clientIP,
        user_agent: userAgent,
        timestamp: new Date(),
        details: result.success ? 'WhatsApp initialization started' : result.error
      });
    }
    
    if (result.success) {
      res.json({
        success: true,
        message: result.message
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error || 'Failed to initialize WhatsApp'
      });
    }
  } catch (error) {
    console.error('Initialize WhatsApp error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// GET /api/whatsapp/status
router.get('/status', (req, res) => {
  const status = getStatus();
  res.json({
    connected: status.connected,
    phone_number: status.phone_number,
    last_seen: status.last_seen || null,
    connection_time: status.connection_time || null,
    qr_available: status.qr_available,
    initialized: status.initialized || false
  });
});

// GET /api/whatsapp/qrcode - Hanya untuk Dashboard
router.get('/qrcode', (req, res) => {
  const status = getStatus();
  
  if (status.qrcode) {
    res.json({ qrcode: status.qrcode });
  } else if (status.connected) {
    res.status(400).json({ error: 'WhatsApp is already connected' });
  } else if (!status.initialized) {
    res.status(400).json({ error: 'WhatsApp not initialized. Call /initialize first.' });
  } else {
    res.status(404).json({ error: 'QR code not available' });
  }
});

// GET /api/whatsapp/device-info - Informasi device yang terhubung
router.get('/device-info', (req, res) => {
  try {
    const status = getStatus();
    
    if (!status.connected) {
      return res.status(400).json({ error: 'WhatsApp is not connected' });
    }
    
    const deviceInfo = getDeviceInfo ? getDeviceInfo() : {};
    res.json({
      platform: deviceInfo.platform || 'Unknown',
      browser: deviceInfo.browser || 'Unknown', 
      wa_version: deviceInfo.wa_version || 'Unknown',
      device_id: deviceInfo.device_id || 'Unknown',
      user_agent: deviceInfo.user_agent || 'Unknown',
      connected_at: deviceInfo.connected_at || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/whatsapp/login-history - Riwayat login
router.get('/login-history', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;
    
    const history = getLoginHistory ? getLoginHistory(limit, offset) : [];
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/whatsapp/disconnect
router.post('/disconnect', async (req, res) => {
  try {
    const clientIP = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');
    
    const result = await disconnect();
    
    // Log disconnect activity
    if (saveLoginHistory) {
      await saveLoginHistory({
        action: 'disconnect',
        success: result.success,
        ip_address: clientIP,
        user_agent: userAgent,
        timestamp: new Date(),
        details: result.success ? 'Manual disconnect' : result.error
      });
    }
    
    if (result.success) {
      res.json({ message: 'WhatsApp disconnected successfully' });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/whatsapp/refresh-qrcode - Hanya untuk Dashboard
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

// GET /api/whatsapp/account-summary - Summary untuk halaman akun
router.get('/account-summary', (req, res) => {
  try {
    const status = getStatus();
    const deviceInfo = status.connected && getDeviceInfo ? getDeviceInfo() : null;
    const recentHistory = getLoginHistory ? getLoginHistory(3, 0) : []; // 3 terakhir
    
    res.json({
      status: {
        connected: status.connected,
        phone_number: status.phone_number,
        last_seen: status.last_seen,
        connection_time: status.connection_time,
        initialized: status.initialized
      },
      device: deviceInfo ? {
        platform: deviceInfo.platform,
        browser: deviceInfo.browser,
        wa_version: deviceInfo.wa_version,
        device_id: deviceInfo.device_id,
        connected_at: deviceInfo.connected_at
      } : null,
      recent_activity: recentHistory
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/whatsapp/force-refresh - Force refresh status
router.post('/force-refresh', async (req, res) => {
  try {
    // Trigger refresh status dari WhatsApp service
    const status = await getStatus(true); // force refresh
    res.json({
      message: 'Status refreshed successfully',
      status: {
        connected: status.connected,
        phone_number: status.phone_number,
        last_seen: status.last_seen,
        initialized: status.initialized
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;