const express = require('express');
const cors = require('cors');
const http = require('http');
const { setupSocket } = require('./config/socket');
const { connectDatabase } = require('./config/database');
const { prepareWhatsApp } = require('./services/whatsapp'); // Ganti dari initializeWhatsApp

// Import routes
const dashboardRoutes = require('./routes/dashboard');
const whatsappRoutes = require('./routes/whatsapp');
const settingsRoutes = require('./routes/settings');
const otpRoutes = require('./routes/otp');
const authRoutes = require('./routes/auth');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Setup Socket.IO
const io = setupSocket(server, FRONTEND_URL);

// Middleware
app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json());

// Make io accessible to routes
app.set('io', io);

// Routes
app.use('/api', dashboardRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api', otpRoutes);
app.use('/auth', authRoutes);

// Health check
app.get('/health', (req, res) => {
  const { getStatus } = require('./services/whatsapp');
  const waStatus = getStatus();
  res.json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    whatsapp: {
      connected: waStatus.connected,
      phone_number: waStatus.phone_number,
      qr_available: waStatus.qr_available,
      initialized: waStatus.initialized || false
    }
  });
});

// Endpoint restart server (hanya untuk admin/internal, pakai API key sederhana)
app.post('/api/restart', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ message: 'Restarting server...' });
  process.exit(1); // Railway akan otomatis restart
});

// Initialize services
async function startServer() {
  try {
    await connectDatabase();
    
    // Hanya prepare WhatsApp service, tidak langsung initialize
    await prepareWhatsApp(io);
    
    server.listen(PORT, () => {
      console.log(`🚀 WhatsApp OTP Gateway running on port ${PORT}`);
      console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
      console.log(`📱 WhatsApp ready to initialize when requested`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('👋 Shutting down gracefully...');
  const { cleanup } = require('./services/whatsapp');
  await cleanup();
  server.close(() => process.exit(0));
});

startServer();