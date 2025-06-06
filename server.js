const express = require('express');
const cors = require('cors');
const http = require('http'); // Import HTTP module for Socket.IO
const { Server } = require('socket.io'); // Import Server from socket.io
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const server = http.createServer(app); // Create HTTP server from Express app
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000'; // Default for development

// --- Socket.IO Setup ---
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL, // Batasi origin Socket.IO hanya ke frontend Anda
    methods: ["GET", "POST"]
  }
});
// -----------------------

// --- Middleware ---
app.use(cors({
  origin: FRONTEND_URL // Batasi origin CORS untuk Express API
}));
app.use(express.json());
// ------------------

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch(err => console.error('❌ MongoDB connection error:', err));
// --------------------------

// --- Database Schemas ---
const LogSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  message: { type: String, required: true },
  status: { type: String, enum: ['success', 'failed', 'pending'], default: 'pending' },
  error_message: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Tambahkan indeks untuk performa query yang lebih baik
LogSchema.index({ created_at: -1 });
LogSchema.index({ status: 1 });
LogSchema.index({ phone: 1 });

const SettingsSchema = new mongoose.Schema({
  webhook_url: { type: String, default: '' },
  api_key: { type: String, required: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const Log = mongoose.model('Log', LogSchema);
const Settings = mongoose.model('Settings', SettingsSchema);
// ------------------------

// --- WhatsApp Client State ---
let sock;
let qrCodeData = null;
let isConnected = false;
let phoneNumber = null;
// -----------------------------

// --- Utility Functions ---
function generateId() {
  return 'TX' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

function generateApiKey() {
  // Menggunakan crypto untuk API key yang lebih kuat
  const crypto = require('crypto');
  return 'sk_' + crypto.randomBytes(16).toString('hex'); // 32 karakter hex
}

// Fungsi untuk emit status WhatsApp ke semua klien Socket.IO
function emitWhatsAppStatus() {
  io.emit('whatsapp-status', {
    connected: isConnected,
    phone_number: phoneNumber ? `+${phoneNumber}` : null,
    qr_available: !!qrCodeData,
    qrcode: qrCodeData // Kirim QR code juga via socket
  });
  console.log('Emitted WhatsApp status:', { connected: isConnected, qr_available: !!qrCodeData });
}

// Initialize WhatsApp Connection
async function initializeWhatsApp() {
  console.log('🔄 Initializing WhatsApp connection...');
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['WA OTP Gateway', 'Chrome', '1.0'], // Custom browser info
      markOnlineOnConnect: false, // Don't show online immediately
      getMessage: async (key) => { // Required for messages
        return {
          // Anda mungkin perlu menyimpan pesan di DB jika ingin membalas atau mengakses riwayat
          // Untuk OTP gateway, ini mungkin tidak terlalu relevan
        };
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        qrCodeData = await QRCode.toDataURL(qr);
        console.log('✅ QR Code generated. Scan to connect.');
        // Emit QR code via Socket.IO
        emitWhatsAppStatus();
      }
      
      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
        
        isConnected = false;
        phoneNumber = null;
        qrCodeData = null; // Clear QR data on close
        emitWhatsAppStatus(); // Emit status after update
        
        // Coba reconnect hanya jika bukan logout
        if (shouldReconnect) {
          console.log('Attempting to reconnect WhatsApp...');
          // Delay sedikit sebelum reconnect untuk menghindari loop terlalu cepat
          setTimeout(() => initializeWhatsApp(), 5000); 
        } else {
          console.log('WhatsApp logged out. Manual scan required to reconnect.');
        }
      } else if (connection === 'open') {
        console.log('🎉 WhatsApp connected successfully');
        isConnected = true;
        phoneNumber = sock.user?.id?.split(':')[0] || null;
        qrCodeData = null; // Clear QR code once connected
        emitWhatsAppStatus(); // Emit status after update
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // Menangani pesan masuk (opsional, jika Anda ingin melacak OTP yang diterima)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type === 'notify') {
        for (const message of messages) {
          if (!message.key.fromMe && message.message) { // Pesan masuk dari orang lain
            const senderId = message.key.remoteJid;
            const senderPhone = senderId.split('@')[0];
            const messageText = message.message.extendedTextMessage?.text || message.message.conversation || '';
            console.log(`Pesan masuk dari ${senderPhone}: ${messageText}`);
            
            // TODO: Tambahkan logika untuk mendeteksi dan memproses OTP yang masuk
            // Misalnya, simpan ke database atau kirim notifikasi ke sistem lain
            // Contoh: Jika pesan berisi "OTP Anda adalah 123456", Anda bisa mengekstraknya
            // if (messageText.includes("OTP Anda adalah")) { ... }
          }
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Error initializing WhatsApp:', error);
    isConnected = false;
    phoneNumber = null;
    qrCodeData = null; // Ensure QR is cleared on error
    emitWhatsAppStatus(); // Emit error status
  }
}

// Fungsi untuk mengirim pesan WhatsApp (tetap sinkron untuk kesederhanaan, pertimbangkan antrean untuk skala)
async function sendWhatsAppMessage(phone, message) {
  try {
    if (!isConnected || !sock) {
      throw new Error('WhatsApp not connected or session not initialized.');
    }
    
    // Pastikan nomor telepon ada kode negara (e.g., 62812...)
    const formattedPhone = phone.replace(/\D/g, ''); // Hapus semua non-digit
    if (!formattedPhone.startsWith('62') && formattedPhone.length > 5) { // Asumsi default Indonesia jika tidak ada kode negara
      // Anda mungkin perlu validasi yang lebih ketat atau parameter kode negara
      console.warn(`Nomor ${phone} tidak diawali 62. Mengasumsikan 62.`);
      // formattedPhone = '62' + formattedPhone; // Uncomment jika ingin menambahkan 62 secara otomatis
    }

    const jid = formattedPhone + '@s.whatsapp.net';
    
    console.log(`Mengirim pesan ke ${jid}: "${message}"`);
    await sock.sendMessage(jid, { text: message });
    return { success: true };
  } catch (error) {
    console.error('❌ Error sending message:', error.message);
    return { success: false, error: error.message };
  }
}
// -------------------------

// --- API Routes ---

  // 1. Dashboard APIs
  app.get('/api/status', (req, res) => {
    res.json({
      whatsapp_connected: isConnected,
      phone_number: phoneNumber ? `+${phoneNumber}` : null
    });
  });

  app.get('/api/statistik', async (req, res) => {
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

  app.get('/api/logs', async (req, res) => {
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
          toDate.setDate(toDate.getDate() + 1); // Akhir hari
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

// 2. WhatsApp Management APIs
app.get('/api/whatsapp/status', (req, res) => {
  res.json({
    connected: isConnected,
    phone_number: phoneNumber ? `+${phoneNumber}` : null,
    qr_available: !!qrCodeData
  });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      console.log('WhatsApp session logged out by user request.');
    }
    // Hapus sesi lokal agar Baileys tidak reconnect ke sesi yang sama
    const fs = require('fs');
    const fsp = require('fs/promises');
    const path = require('path');
    const authInfoPath = path.resolve(__dirname, 'auth_info');
    if (fs.existsSync(authInfoPath)) {
      await fsp.rm(authInfoPath, { recursive: true, force: true });
      console.log('Deleted auth_info directory.');
    }

    isConnected = false;
    phoneNumber = null;
    qrCodeData = null;
    emitWhatsAppStatus();

    res.json({ message: 'WhatsApp disconnected successfully. Authentication info cleared.' });
  } catch (error) {
    console.error('Error disconnecting WhatsApp:', error.message);
    res.status(500).json({ error: 'Failed to disconnect WhatsApp: ' + error.message });
  }
});

app.get('/api/whatsapp/qrcode', (req, res) => {
  if (qrCodeData) {
    res.json({ qrcode: qrCodeData });
  } else if (isConnected) {
    res.status(400).json({ error: 'WhatsApp is already connected. QR code is not available.' });
  } else {
    res.status(404).json({ error: 'QR code not available. Please wait or refresh.' });
  }
});

app.post('/api/whatsapp/refresh-qrcode', async (req, res) => {
  try {
    if (isConnected) {
      console.warn('QR code regeneration attempted while already connected.');
      return res.status(400).json({ error: 'WhatsApp is already connected. Cannot refresh QR code.' });
    }
    
    console.log('Request to refresh QR code received.');
    // Baileys akan otomatis menghasilkan QR baru jika tidak ada sesi aktif
    // Jadi, cukup panggil initializeWhatsApp lagi.
    // Jika ada QR lama yang masih valid, ini akan me-replace-nya
    await initializeWhatsApp(); 
    
    res.json({ message: 'QR code refresh initiated. Please wait for a new QR code.' });
  } catch (error) {
    console.error('Error refreshing QR code:', error.message);
    res.status(500).json({ error: 'Failed to refresh QR code: ' + error.message });
  }
});

// 3. Settings APIs
app.get('/api/settings', async (req, res) => {
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

app.post('/api/settings', async (req, res) => {
  try {
    const { webhook_url, api_key } = req.body;
    
    let settings = await Settings.findOne();
    if (settings) {
      settings.webhook_url = webhook_url;
      // Hanya update API key jika diberikan dari request
      if (api_key) settings.api_key = api_key; 
      settings.updated_at = new Date();
      await settings.save();
    } else {
      // Jika belum ada settings, buat baru
      settings = new Settings({
        webhook_url,
        api_key: api_key || generateApiKey() // Generate jika tidak disediakan
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

app.post('/api/settings/generate-apikey', async (req, res) => {
  try {
    const newApiKey = generateApiKey();
    
    let settings = await Settings.findOne();
    if (settings) {
      settings.api_key = newApiKey;
      settings.updated_at = new Date();
      await settings.save();
    } else {
      settings = new Settings({
        webhook_url: '', // Default kosong
        api_key: newApiKey
      });
      await settings.save();
    }
    
    res.json({
      message: 'New API key generated successfully',
      api_key: newApiKey
    });
  } catch (error) {
    console.error('Error generating new API key:', error.message);
    res.status(500).json({ error: 'Failed to generate new API key' });
  }
});

// 4. OTP Sending API (Main functionality)
app.post('/api/send-otp', async (req, res) => {
  try {
    const { phone, message, api_key } = req.body;
    
    // Validasi API key
    const settings = await Settings.findOne();
    if (!settings || settings.api_key !== api_key) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // Validasi input
    if (!phone || !message) {
      return res.status(400).json({ error: 'Phone and message are required' });
    }
    
    const logId = generateId();
    
    // Buat log entry awal dengan status pending
    const log = new Log({
      id: logId,
      phone: phone,
      message: message,
      status: 'pending'
    });
    await log.save();
    
    // --- PENTING: Untuk skala produksi, pertimbangkan ANTRIAN PESAN di sini ---
    // Misalnya, tambahkan ke Redis Queue, lalu worker terpisah yang mengirim
    // Ini menjaga API Anda responsif dan tahan terhadap delay pengiriman WA.
    // Contoh sederhana saat ini: tetap mengirim secara langsung (synchronous)
    // ---------------------------------------------------------------------

    const result = await sendWhatsAppMessage(phone, message);
    
    // Update status log
    log.status = result.success ? 'success' : 'failed';
    log.error_message = result.success ? null : result.error;
    log.updated_at = new Date();
    await log.save();
    
    // Kirim notifikasi webhook jika dikonfigurasi
    if (settings.webhook_url) {
      try {
        const fetch = require('node-fetch'); // Pastikan 'node-fetch' terinstal jika menggunakan Node.js < 18
        await fetch(settings.webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: logId,
            phone: phone,
            status: log.status,
            timestamp: log.updated_at.toISOString(),
            error_message: log.error_message
          })
        });
        console.log(`Webhook triggered for ID ${logId} with status ${log.status}`);
      } catch (webhookError) {
        console.error('❌ Webhook error for ID', logId, ':', webhookError.message);
      }
    }
    
    res.json({
      id: logId,
      status: log.status,
      message: result.success ? 'OTP sent successfully' : 'Failed to send OTP',
      error: result.error || null
    });
    
  } catch (error) {
    console.error('❌ Error in /api/send-otp:', error.message);
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    whatsapp_connected: isConnected,
    phone_number: phoneNumber ? `+${phoneNumber}` : null
  });
});
// ------------------

// --- Initialize WhatsApp on startup ---
initializeWhatsApp();
// --------------------------------------

// --- Graceful Shutdown ---
process.on('SIGINT', async () => {
  console.log('👋 SIGINT signal received: Shutting down gracefully...');
  if (sock) {
    console.log('Logging out WhatsApp session...');
    await sock.logout();
    console.log('WhatsApp session logged out.');
  }
  if (mongoose.connection.readyState === 1) { // Check if connected before disconnecting
    console.log('Disconnecting from MongoDB...');
    await mongoose.disconnect();
    console.log('MongoDB disconnected.');
  }
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('👋 SIGTERM signal received: Shutting down gracefully...');
  if (sock) {
    console.log('Logging out WhatsApp session...');
    await sock.logout();
    console.log('WhatsApp session logged out.');
  }
  if (mongoose.connection.readyState === 1) {
    console.log('Disconnecting from MongoDB...');
    await mongoose.disconnect();
    console.log('MongoDB disconnected.');
  }
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
});
// -------------------------

// --- Start server ---
server.listen(PORT, () => {
  console.log(`🚀 WhatsApp OTP Gateway Backend running on port ${PORT}`);
  console.log(`🌐 Accessible from frontend at ${FRONTEND_URL}`);
});

