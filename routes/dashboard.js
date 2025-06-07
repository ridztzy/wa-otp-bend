const express = require('express');
const router = express.Router();
const Log = require('../models/Log');

// GET /api/status - Status lengkap dengan informasi tambahan
router.get('/status', (req, res) => {
  const { getStatus } = require('../services/whatsapp');
  const status = getStatus();
  
  res.json({
    whatsapp_connected: status.whatsapp_connected,
    phone_number: status.phone_number,
    qr_available: status.qr_available,
    qrcode: status.qrcode,
    reconnect_attempts: status.reconnect_attempts,
    max_attempts: status.max_attempts
  });
});

// POST /api/whatsapp/disconnect - Memutus koneksi dan hapus sesi
router.post('/whatsapp/disconnect', async (req, res) => {
  try {
    const { disconnect } = require('../services/whatsapp');
    const result = await disconnect();
    
    if (result.success) {
      res.json({
        success: true,
        message: 'WhatsApp disconnected and session cleared. QR scan required for next login.'
      });
    } else {
      res.status(500).json({ 
        success: false,
        error: result.error || 'Failed to disconnect WhatsApp' 
      });
    }
  } catch (error) {
    console.error('Error disconnecting WhatsApp:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to disconnect WhatsApp' 
    });
  }
});

// POST /api/whatsapp/refresh-qr - Generate QR code baru
router.post('/whatsapp/refresh-qr', async (req, res) => {
  try {
    const { refreshQR } = require('../services/whatsapp');
    const result = await refreshQR();
    
    if (result.success) {
      res.json({
        success: true,
        message: 'QR code refreshed successfully. Check status for new QR.'
      });
    } else {
      res.status(400).json({ 
        success: false,
        error: result.error || 'Failed to refresh QR code' 
      });
    }
  } catch (error) {
    console.error('Error refreshing QR:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to refresh QR code' 
    });
  }
});

// POST /api/whatsapp/force-reconnect - Force reconnect dengan clear session
router.post('/whatsapp/force-reconnect', async (req, res) => {
  try {
    const { forceReconnect } = require('../services/whatsapp');
    const result = await forceReconnect();
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Force reconnect initiated. Check status for connection progress.'
      });
    } else {
      res.status(500).json({ 
        success: false,
        error: result.error || 'Failed to force reconnect' 
      });
    }
  } catch (error) {
    console.error('Error force reconnecting WhatsApp:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to force reconnect WhatsApp' 
    });
  }
});

// GET /api/statistik
router.get('/statistik', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const sentToday = await Log.countDocuments({
      created_at: { $gte: today, $lt: tomorrow },
      status: 'success'
    });
    
    const failedToday = await Log.countDocuments({
      created_at: { $gte: today, $lt: tomorrow },
      status: 'failed'
    });
    
    const totalToday = sentToday + failedToday;
    const successRate = totalToday > 0 ? Math.round((sentToday / totalToday) * 100) : 0;
    
    res.json({
      sent_today: sentToday,
      failed_today: failedToday,
      total_today: totalToday,
      success_rate: successRate
    });
  } catch (error) {
    console.error('Error fetching statistics:', error.message);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/logs
router.get('/logs', async (req, res) => {
  try {
    const { limit = 10, page = 1, status, phone, from, to } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    let filter = {};
    if (status) filter.status = status;
    if (phone) filter.phone = { $regex: phone, $options: 'i' };
    if (from || to) {
      filter.created_at = {};
      if (from) filter.created_at.$gte = new Date(from);
      if (to) {
        const toDate = new Date(to);
        toDate.setDate(toDate.getDate() + 1);
        filter.created_at.$lt = toDate;
      }
    }
    
    const logs = await Log.find(filter)
      .sort({ created_at: -1 })
      .limit(parseInt(limit))
      .skip(skip);
    
    const total = await Log.countDocuments(filter);
    
    const formattedLogs = logs.map(log => ({
      id: log.id,
      phone: log.phone,
      message: log.message,
      status: log.status,
      error_message: log.error_message,
      time: log.created_at.toISOString()
    }));
    
    res.json({
      data: formattedLogs,
      pagination: {
        current_page: parseInt(page),
        total_pages: Math.ceil(total / parseInt(limit)),
        total_items: total,
        per_page: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Error fetching logs:', error.message);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// DELETE /api/logs - Menghapus logs (opsional, untuk maintenance)
router.delete('/logs', async (req, res) => {
  try {
    const { older_than_days } = req.query;
    
    let filter = {};
    if (older_than_days) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - parseInt(older_than_days));
      filter.created_at = { $lt: cutoffDate };
    }
    
    const result = await Log.deleteMany(filter);
    
    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} log entries`,
      deleted_count: result.deletedCount
    });
  } catch (error) {
    console.error('Error deleting logs:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete logs' 
    });
  }
});

module.exports = router;