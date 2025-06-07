const Settings = require('../models/Settings');

async function validateApiKey(req, res, next) {
  try {
    const { api_key } = req.body;
    
    if (!api_key) {
      return res.status(401).json({ error: 'API key is required' });
    }
    
    const settings = await Settings.findOne();
    if (!settings || settings.api_key !== api_key) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    next();
  } catch (error) {
    res.status(500).json({ error: 'Authentication error' });
  }
}

module.exports = { validateApiKey };