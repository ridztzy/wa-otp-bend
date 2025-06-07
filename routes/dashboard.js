const express = require('express');
const router = express.Router();
const Log = require('../models/Log');

// GET /api/status
router.get('/status', (req, res) => {
  const { getStatus } = require('../services/whatsapp');
  const status = getStatus();
  
  res.json({
    whatsapp_connected: status.connected,
    phone_number: status.phone_number
  });
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

module.exports = router;