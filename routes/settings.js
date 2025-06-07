const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');
const { generateApiKey } = require('../utils/helpers');
const { validateSettingsRequest } = require('../middleware/validation');

// GET /api/settings
router.get('/', async (req, res) => {
  try {
    const settings = await Settings.findOne() || {};
    res.json({
      webhook_url: settings.webhook_url || '',
      api_key: settings.api_key || ''
    });
  } catch (error) {
    console.error('Error fetching settings:', error.message);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// POST /api/settings
router.post('/', validateSettingsRequest, async (req, res) => {
  try {
    const { webhook_url, api_key } = req.body;
    
    let settings = await Settings.findOne();
    if (settings) {
      settings.webhook_url = webhook_url || settings.webhook_url;
      if (api_key) settings.api_key = api_key;
      settings.updated_at = new Date();
      await settings.save();
    } else {
      settings = new Settings({
        webhook_url: webhook_url || '',
        api_key: api_key || generateApiKey()
      });
      await settings.save();
    }
    
    res.json({
      message: 'Settings updated successfully',
      webhook_url: settings.webhook_url,
      api_key: settings.api_key
    });
  } catch (error) {
    console.error('Error updating settings:', error.message);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// POST /api/settings/generate-apikey
router.post('/generate-apikey', async (req, res) => {
  try {
    const newApiKey = generateApiKey();
    
    let settings = await Settings.findOne();
    if (settings) {
      settings.api_key = newApiKey;
      settings.updated_at = new Date();
      await settings.save();
    } else {
      settings = new Settings({
        webhook_url: '',
        api_key: newApiKey
      });
      await settings.save();
    }
    
    res.json({
      message: 'New API key generated successfully',
      api_key: newApiKey
    });
  } catch (error) {
    console.error('Error generating API key:', error.message);
    res.status(500).json({ error: 'Failed to generate API key' });
  }
});

module.exports = router;