const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const mongoose = require('mongoose');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// --- Constants ---
const MAX_RETRY_ATTEMPTS = 3;
const RECONNECT_DELAY = 5000;
const QR_TIMEOUT = 60000; // 60 seconds
const MESSAGE_TIMEOUT = 30000; // 30 seconds

// --- Socket.IO Setup ---
const io = new Server(server, {
    cors: {
        origin: FRONTEND_URL,
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

// --- Middleware ---
app.use(cors({
    origin: FRONTEND_URL,
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// --- MongoDB Connection with improved error handling ---
const connectDB = async () => {
    try {
        const options = {
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            bufferCommands: false,
            bufferMaxEntries: 0,
        };
        
        await mongoose.connect(process.env.MONGODB_URI, options);
        console.log('✅ MongoDB connected successfully');
        
        mongoose.connection.on('error', (err) => {
            console.error('❌ MongoDB connection error:', err);
        });
        
        mongoose.connection.on('disconnected', () => {
            console.warn('⚠️ MongoDB disconnected. Attempting to reconnect...');
        });
        
        mongoose.connection.on('reconnected', () => {
            console.log('✅ MongoDB reconnected successfully');
        });
        
    } catch (err) {
        console.error('❌ Initial MongoDB connection error:', err);
        process.exit(1);
    }
};

// --- Enhanced Database Schemas ---
const LogSchema = new mongoose.Schema({
    id: { 
        type: String, 
        required: true, 
        unique: true,
        index: true
    },
    phone: { 
        type: String, 
        required: true,
        validate: {
            validator: function(v) {
                return /^\d{10,15}$/.test(v.replace(/\D/g, ''));
            },
            message: 'Phone number must be 10-15 digits'
        }
    },
    message: { 
        type: String, 
        required: true,
        maxlength: 1000
    },
    status: { 
        type: String, 
        enum: ['success', 'failed', 'pending'], 
        default: 'pending',
        index: true
    },
    error_message: { 
        type: String, 
        default: null,
        maxlength: 500
    },
    retry_count: {
        type: Number,
        default: 0,
        min: 0,
        max: MAX_RETRY_ATTEMPTS
    },
    delivery_time: {
        type: Number, // milliseconds
        default: null
    },
    created_at: { 
        type: Date, 
        default: Date.now,
        index: true
    },
    updated_at: { 
        type: Date, 
        default: Date.now 
    }
});

// Compound indexes for better query performance
LogSchema.index({ created_at: -1, status: 1 });
LogSchema.index({ phone: 1, created_at: -1 });

const SettingsSchema = new mongoose.Schema({
    webhook_url: { 
        type: String, 
        default: '',
        validate: {
            validator: function(v) {
                if (!v) return true; // Allow empty
                return /^https?:\/\/.+/.test(v);
            },
            message: 'Webhook URL must be a valid HTTP/HTTPS URL'
        }
    },
    api_key: { 
        type: String, 
        required: true,
        unique: true,
        minlength: 32
    },
    webhook_enabled: {
        type: Boolean,
        default: false
    },
    max_daily_messages: {
        type: Number,
        default: 1000,
        min: 1
    },
    created_at: { 
        type: Date, 
        default: Date.now 
    },
    updated_at: { 
        type: Date, 
        default: Date.now 
    }
});

const Log = mongoose.model('Log', LogSchema);
const Settings = mongoose.model('Settings', SettingsSchema);

// --- WhatsApp Client State ---
let sock = null;
let qrCodeData = null;
let isConnected = false;
let phoneNumber = null;
let isInitializing = false;
let retryCount = 0;
let qrCodeTimer = null;

// --- Enhanced Utility Functions ---
function generateId() {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(6).toString('hex').toUpperCase();
    return `TX${timestamp}${random}`;
}

function generateApiKey() {
    return 'sk_' + crypto.randomBytes(24).toString('hex');
}

function formatPhoneNumber(phone) {
    // Remove all non-digits
    const cleaned = phone.replace(/\D/g, '');
    
    // Basic validation
    if (cleaned.length < 10 || cleaned.length > 15) {
        throw new Error('Invalid phone number format');
    }
    
    // Add country code if missing (assuming Indonesia as default)
    if (!cleaned.startsWith('62') && cleaned.length <= 12) {
        if (cleaned.startsWith('0')) {
            return '62' + cleaned.substring(1);
        }
        return '62' + cleaned;
    }
    
    return cleaned;
}

function validateApiKey(providedKey, storedKey) {
    if (!providedKey || !storedKey) return false;
    return crypto.timingSafeEqual(
        Buffer.from(providedKey),
        Buffer.from(storedKey)
    );
}

// Enhanced status emission with error handling
function emitWhatsAppStatus() {
    try {
        const status = {
            connected: isConnected,
            phone_number: phoneNumber ? `+${phoneNumber}` : null,
            qr_available: !!qrCodeData,
            qrcode: qrCodeData,
            retry_count: retryCount,
            timestamp: new Date().toISOString()
        };
        
        io.emit('whatsapp-status', status);
        console.log(`📡 Emitted WhatsApp status: ${JSON.stringify({ 
            connected: status.connected, 
            qr_available: status.qr_available,
            retry_count: status.retry_count
        })}`);
    } catch (error) {
        console.error('❌ Error emitting WhatsApp status:', error.message);
    }
}

// Enhanced rate limiting check
async function checkRateLimit() {
    try {
        const settings = await Settings.findOne();
        if (!settings) return true;
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const todayCount = await Log.countDocuments({
            created_at: { $gte: today, $lt: tomorrow },
            status: { $in: ['success', 'pending'] }
        });
        
        return todayCount < settings.max_daily_messages;
    } catch (error) {
        console.error('❌ Error checking rate limit:', error.message);
        return true; // Allow if check fails
    }
}

// Enhanced webhook notification
async function sendWebhookNotification(logData) {
    try {
        const settings = await Settings.findOne();
        if (!settings || !settings.webhook_enabled || !settings.webhook_url) {
            return;
        }
        
        const payload = {
            id: logData.id,
            phone: logData.phone,
            status: logData.status,
            message: logData.message,
            error_message: logData.error_message,
            delivery_time: logData.delivery_time,
            retry_count: logData.retry_count,
            timestamp: logData.updated_at.toISOString()
        };
        
        // Use node-fetch or axios for Node.js < 18
        const response = await fetch(settings.webhook_url, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'User-Agent': 'WhatsApp-OTP-Gateway/1.0'
            },
            body: JSON.stringify(payload),
            timeout: 10000 // 10 seconds timeout
        });
        
        if (response.ok) {
            console.log(`✅ Webhook sent successfully for ID ${logData.id}`);
        } else {
            console.error(`❌ Webhook failed for ID ${logData.id}: ${response.status}`);
        }
        
    } catch (error) {
        console.error(`❌ Webhook error for ID ${logData.id}:`, error.message);
    }
}

// Enhanced WhatsApp initialization with better error handling
async function initializeWhatsApp() {
    if (isInitializing) {
        console.log('🔄 WhatsApp connection is already initializing. Skipping.');
        return;
    }
    
    isInitializing = true;
    console.log('🔄 Initializing WhatsApp connection...');
    
    try {
        // Clear any existing QR timer
        if (qrCodeTimer) {
            clearTimeout(qrCodeTimer);
            qrCodeTimer = null;
        }
        
        const authInfoPath = path.resolve(__dirname, 'auth_info');
        const { state, saveCreds } = await useMultiFileAuthState(authInfoPath);

        // Close existing socket if any
        if (sock && sock.ws && sock.ws.readyState === sock.ws.OPEN) {
            console.log('🔌 Closing existing WhatsApp socket...');
            try {
                await sock.logout();
            } catch (logoutError) {
                console.warn('⚠️ Error during logout:', logoutError.message);
            }
        }

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['WA OTP Gateway', 'Chrome', '1.0.0'],
            markOnlineOnConnect: false,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            getMessage: async (key) => {
                // Return empty message for simplicity
                return { conversation: '' };
            }
        });

        // Connection update handler
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                try {
                    qrCodeData = await QRCode.toDataURL(qr);
                    console.log('📱 QR Code generated successfully');
                    emitWhatsAppStatus();
                    
                    // Set QR code timeout
                    qrCodeTimer = setTimeout(() => {
                        console.log('⏰ QR Code expired, generating new one...');
                        qrCodeData = null;
                        if (!isConnected) {
                            initializeWhatsApp();
                        }
                    }, QR_TIMEOUT);
                    
                } catch (qrError) {
                    console.error('❌ Error generating QR code:', qrError.message);
                }
            }
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                const reason = lastDisconnect?.error?.output?.statusCode;
                
                console.log(`🔌 Connection closed. Reason: ${reason}, Should reconnect: ${shouldReconnect}`);
                
                isConnected = false;
                phoneNumber = null;
                qrCodeData = null;
                
                if (qrCodeTimer) {
                    clearTimeout(qrCodeTimer);
                    qrCodeTimer = null;
                }
                
                emitWhatsAppStatus();
                
                if (shouldReconnect && retryCount < MAX_RETRY_ATTEMPTS) {
                    retryCount++;
                    console.log(`🔄 Attempting to reconnect (${retryCount}/${MAX_RETRY_ATTEMPTS})...`);
                    
                    setTimeout(() => {
                        if (!isInitializing && !isConnected) {
                            initializeWhatsApp();
                        }
                    }, RECONNECT_DELAY * retryCount); // Exponential backoff
                } else if (reason === DisconnectReason.loggedOut) {
                    console.log('🚪 WhatsApp logged out. Manual scan required.');
                    retryCount = 0;
                } else {
                    console.log('❌ Max retry attempts reached. Manual intervention required.');
                    retryCount = 0;
                }
                
            } else if (connection === 'open') {
                console.log('🎉 WhatsApp connected successfully');
                isConnected = true;
                phoneNumber = sock.user?.id?.split(':')[0] || null;
                qrCodeData = null;
                retryCount = 0;
                
                if (qrCodeTimer) {
                    clearTimeout(qrCodeTimer);
                    qrCodeTimer = null;
                }
                
                emitWhatsAppStatus();
            }
        });

        // Credentials update handler
        sock.ev.on('creds.update', saveCreds);

        // Enhanced message handler for incoming OTP detection
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type === 'notify') {
                for (const message of messages) {
                    if (!message.key.fromMe && message.message) {
                        const senderId = message.key.remoteJid;
                        const senderPhone = senderId.split('@')[0];
                        const messageText = message.message.extendedTextMessage?.text || 
                                         message.message.conversation || '';
                        
                        console.log(`📨 Incoming message from ${senderPhone}: ${messageText.substring(0, 50)}...`);
                        
                        // Emit incoming message via Socket.IO for real-time monitoring
                        io.emit('incoming-message', {
                            from: senderPhone,
                            message: messageText,
                            timestamp: new Date().toISOString()
                        });
                        
                        // TODO: Add OTP detection logic here
                        // Example: detect patterns like "123456", "Your OTP is 123456", etc.
                    }
                }
            }
        });

    } catch (error) {
        console.error('❌ Error initializing WhatsApp:', error.message);
        isConnected = false;
        phoneNumber = null;
        qrCodeData = null;
        emitWhatsAppStatus();
        
        // Retry with exponential backoff
        if (retryCount < MAX_RETRY_ATTEMPTS) {
            retryCount++;
            setTimeout(() => {
                if (!isConnected) {
                    initializeWhatsApp();
                }
            }, RECONNECT_DELAY * retryCount);
        }
    } finally {
        isInitializing = false;
    }
}

// Enhanced message sending with retry logic
async function sendWhatsAppMessage(phone, message, logId) {
    const startTime = Date.now();
    
    try {
        if (!isConnected || !sock) {
            throw new Error('WhatsApp not connected or session not initialized');
        }
        
        const formattedPhone = formatPhoneNumber(phone);
        const jid = formattedPhone + '@s.whatsapp.net';
        
        console.log(`📤 Sending message to ${jid}: "${message.substring(0, 50)}..."`);
        
        // Send message with timeout
        const sendPromise = sock.sendMessage(jid, { text: message });
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Message sending timeout')), MESSAGE_TIMEOUT);
        });
        
        await Promise.race([sendPromise, timeoutPromise]);
        
        const deliveryTime = Date.now() - startTime;
        console.log(`✅ Message sent successfully in ${deliveryTime}ms`);
        
        return { 
            success: true, 
            delivery_time: deliveryTime 
        };
        
    } catch (error) {
        const deliveryTime = Date.now() - startTime;
        console.error(`❌ Error sending message (${deliveryTime}ms):`, error.message);
        
        return { 
            success: false, 
            error: error.message,
            delivery_time: deliveryTime
        };
    }
}

// --- Enhanced API Routes ---

// 1. Dashboard APIs with improved error handling
app.get('/api/status', async (req, res) => {
    try {
        res.json({
            whatsapp_connected: isConnected,
            phone_number: phoneNumber ? `+${phoneNumber}` : null,
            retry_count: retryCount,
            server_uptime: process.uptime(),
            memory_usage: process.memoryUsage(),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error in /api/status:', error.message);
        res.status(500).json({ error: 'Failed to get status' });
    }
});

app.get('/api/statistik', async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        const [sentToday, failedToday, pendingToday, avgDeliveryTime] = await Promise.all([
            Log.countDocuments({
                created_at: { $gte: today, $lt: tomorrow },
                status: 'success'
            }),
            Log.countDocuments({
                created_at: { $gte: today, $lt: tomorrow },
                status: 'failed'
            }),
            Log.countDocuments({
                created_at: { $gte: today, $lt: tomorrow },
                status: 'pending'
            }),
            Log.aggregate([
                {
                    $match: {
                        created_at: { $gte: today, $lt: tomorrow },
                        status: 'success',
                        delivery_time: { $ne: null }
                    }
                },
                {
                    $group: {
                        _id: null,
                        avgTime: { $avg: '$delivery_time' }
                    }
                }
            ])
        ]);
        
        const totalToday = sentToday + failedToday + pendingToday;
        const successRate = totalToday > 0 ? Math.round((sentToday / totalToday) * 100) : 0;
        const avgTime = avgDeliveryTime.length > 0 ? Math.round(avgDeliveryTime[0].avgTime) : 0;
        
        res.json({
            sent_today: sentToday,
            failed_today: failedToday,
            pending_today: pendingToday,
            success_rate: successRate,
            avg_delivery_time: avgTime
        });
    } catch (error) {
        console.error('❌ Error fetching statistics:', error.message);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

app.get('/api/logs', async (req, res) => {
    try {
        const { 
            limit = 10, 
            page = 1, 
            status, 
            phone, 
            from, 
            to,
            sort = 'created_at',
            order = 'desc'
        } = req.query;
        
        const skip = (parseInt(page) - 1) * parseInt(limit);
        
        let filter = {};
        if (status && ['success', 'failed', 'pending'].includes(status)) {
            filter.status = status;
        }
        if (phone) {
            filter.phone = { $regex: phone.replace(/\D/g, ''), $options: 'i' };
        }
        if (from || to) {
            filter.created_at = {};
            if (from) filter.created_at.$gte = new Date(from);
            if (to) {
                const toDate = new Date(to);
                toDate.setDate(toDate.getDate() + 1);
                filter.created_at.$lt = toDate;
            }
        }
        
        const sortOptions = {};
        sortOptions[sort] = order === 'asc' ? 1 : -1;
        
        const [logs, total] = await Promise.all([
            Log.find(filter)
                .sort(sortOptions)
                .limit(parseInt(limit))
                .skip(skip)
                .lean(), // Use lean() for better performance
            Log.countDocuments(filter)
        ]);
        
        const formattedLogs = logs.map(log => ({
            id: log.id,
            phone: log.phone,
            message: log.message.length > 100 ? log.message.substring(0, 100) + '...' : log.message,
            status: log.status,
            error_message: log.error_message,
            retry_count: log.retry_count,
            delivery_time: log.delivery_time,
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
        console.error('❌ Error fetching logs:', error.message);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// 2. Enhanced WhatsApp Management APIs
app.get('/api/whatsapp/status', (req, res) => {
    res.json({
        connected: isConnected,
        phone_number: phoneNumber ? `+${phoneNumber}` : null,
        qr_available: !!qrCodeData,
        retry_count: retryCount,
        initializing: isInitializing
    });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
    try {
        if (sock) {
            console.log('🚪 Disconnecting WhatsApp by user request...');
            await sock.logout();
        }
        
        // Clear authentication info
        const authInfoPath = path.resolve(__dirname, 'auth_info');
        if (fs.existsSync(authInfoPath)) {
            await fsp.rm(authInfoPath, { recursive: true, force: true });
            console.log('🗑️ Deleted auth_info directory');
        }

        isConnected = false;
        phoneNumber = null;
        qrCodeData = null;
        retryCount = 0;
        
        if (qrCodeTimer) {
            clearTimeout(qrCodeTimer);
            qrCodeTimer = null;
        }
        
        emitWhatsAppStatus();

        res.json({ message: 'WhatsApp disconnected successfully' });
    } catch (error) {
        console.error('❌ Error disconnecting WhatsApp:', error.message);
        res.status(500).json({ error: 'Failed to disconnect WhatsApp: ' + error.message });
    }
});

app.get('/api/whatsapp/qrcode', (req, res) => {
    if (qrCodeData) {
        res.json({ qrcode: qrCodeData });
    } else if (isConnected) {
        res.status(400).json({ error: 'WhatsApp is already connected' });
    } else {
        res.status(404).json({ error: 'QR code not available' });
    }
});

app.post('/api/whatsapp/refresh-qrcode', async (req, res) => {
    try {
        if (isConnected) {
            return res.status(400).json({ error: 'WhatsApp is already connected' });
        }
        
        if (isInitializing) {
            return res.status(409).json({ error: 'WhatsApp initialization in progress' });
        }

        console.log('🔄 Refreshing QR code...');
        
        // Clear existing authentication
        const authInfoPath = path.resolve(__dirname, 'auth_info');
        if (fs.existsSync(authInfoPath)) {
            await fsp.rm(authInfoPath, { recursive: true, force: true });
        }
        
        retryCount = 0;
        qrCodeData = null;
        
        await initializeWhatsApp();

        res.json({ message: 'QR code refresh initiated' });
    } catch (error) {
        console.error('❌ Error refreshing QR code:', error.message);
        res.status(500).json({ error: 'Failed to refresh QR code: ' + error.message });
    }
});

// 3. Enhanced Settings APIs
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await Settings.findOne().lean();
        
        res.json({
            webhook_url: settings?.webhook_url || '',
            webhook_enabled: settings?.webhook_enabled || false,
            max_daily_messages: settings?.max_daily_messages || 1000,
            api_key: settings?.api_key || '',
            has_api_key: !!settings?.api_key
        });
    } catch (error) {
        console.error('❌ Error fetching settings:', error.message);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

app.post('/api/settings', async (req, res) => {
    try {  
        const { webhook_url, webhook_enabled, max_daily_messages, api_key } = req.body;
        
        // Validation
        if (webhook_url && !/^https?:\/\/.+/.test(webhook_url)) {
            return res.status(400).json({ error: 'Invalid webhook URL format' });
        }
        
        if (max_daily_messages && (max_daily_messages < 1 || max_daily_messages > 10000)) {
            return res.status(400).json({ error: 'Max daily messages must be between 1 and 10000' });
        }
        
        let settings = await Settings.findOne();
        
        if (settings) {
            if (webhook_url !== undefined) settings.webhook_url = webhook_url;
            if (webhook_enabled !== undefined) settings.webhook_enabled = webhook_enabled;
            if (max_daily_messages !== undefined) settings.max_daily_messages = max_daily_messages;
            if (api_key) settings.api_key = api_key;
            settings.updated_at = new Date();
            await settings.save();
        } else {
            settings = new Settings({
                webhook_url: webhook_url || '',
                webhook_enabled: webhook_enabled || false,
                max_daily_messages: max_daily_messages || 1000,
                api_key: api_key || generateApiKey()
            });
            await settings.save();
        }
        
        res.json({
            message: 'Settings updated successfully',
            webhook_url: settings.webhook_url,
            webhook_enabled: settings.webhook_enabled,
            max_daily_messages: settings.max_daily_messages,
            api_key: settings.api_key
        });
    } catch (error) {
        console.error('❌ Error updating settings:', error.message);
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
        console.error('❌ Error generating API key:', error.message);
        res.status(500).json({ error: 'Failed to generate API key' });
    }
});

// 4. Enhanced OTP Sending API
app.post('/api/send-otp', async (req, res) => {
    const logId = generateId();
    let log = null;
    
    try {
        const { phone, message, api_key } = req.body;
        
        // Input validation
        if (!phone || !message || !api_key) {
            return res.status(400).json({ 
                error: 'Phone, message, and api_key are required' 
            });
        }
        
        // API key validation
        const settings = await Settings.findOne();
        if (!settings || !validateApiKey(api_key, settings.api_key)) {
            return res.status(401).json({ error: 'Invalid API key' });
        }
        
        // Rate limiting check
        const rateLimitOk = await checkRateLimit();
        if (!rateLimitOk) {
            return res.status(429).json({ 
                error: 'Daily message limit exceeded' 
            });
        }
        
        // Phone number validation
        let formattedPhone;
        try {
            formattedPhone = formatPhoneNumber(phone);
        } catch (phoneError) {
            return res.status(400).json({ 
                error: 'Invalid phone number format: ' + phoneError.message 
            });
        }
        
        // Message length validation
        if (message.length > 1000) {
            return res.status(400).json({ 
                error: 'Message too long (max 1000 characters)' 
            });
        }
        
        // Create initial log entry
        log = new Log({
            id: logId,
            phone: formattedPhone,
            message: message,
            status: 'pending'
        });
        await log.save();
        
        // Check WhatsApp connection
        if (!isConnected) {
            log.status = 'failed';
            log.error_message = 'WhatsApp not connected';
            log.updated_at = new Date();
            await log.save();
            
            await sendWebhookNotification(log);
            
            return res.status(503).json({
                id: logId,
                status: 'failed',
                message: 'WhatsApp service unavailable',
                error: 'WhatsApp not connected'
            });
        }
        
        // Send message with retry logic
        let result = null;
        let lastError = null;
        
        for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
            result = await sendWhatsAppMessage(formattedPhone, message, logId);
            
            if (result.success) {
                break;
            }
            
            lastError = result.error;
            log.retry_count = attempt + 1;
            
            if (attempt < MAX_RETRY_ATTEMPTS) {
                console.log(`🔄 Retrying message send (${attempt + 1}/${MAX_RETRY_ATTEMPTS}) for ${logId}`);
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1))); // Exponential delay
            }
        }
        
        // Update log with final result
        log.status = result.success ? 'success' : 'failed';
        log.error_message = result.success ? null : lastError;
        log.delivery_time = result.delivery_time;
        log.updated_at = new Date();
        await log.save();
        
        // Send webhook notification
        await sendWebhookNotification(log);
        
        // Emit real-time update
        io.emit('message-update', {
            id: logId,
            status: log.status,
            phone: formattedPhone,
            delivery_time: log.delivery_time,
            retry_count: log.retry_count
        });
        
        const responseData = {
            id: logId,
            status: log.status,
            message: result.success ? 'OTP sent successfully' : 'Failed to send OTP',
            delivery_time: result.delivery_time,
            retry_count: log.retry_count
        };
        
        if (!result.success) {
            responseData.error = lastError;
        }
        
        res.status(result.success ? 200 : 500).json(responseData);
        
    } catch (error) {
        console.error(`❌ Error in /api/send-otp (${logId}):`, error.message);
        
        // Update log if it exists
        if (log) {
            try {
                log.status = 'failed';
                log.error_message = error.message;
                log.updated_at = new Date();
                await log.save();
                await sendWebhookNotification(log);
            } catch (logError) {
                console.error('❌ Error updating log:', logError.message);
            }
        }
        
        res.status(500).json({ 
            id: logId,
            status: 'failed',
            error: 'Internal server error: ' + error.message 
        });
    }
});

// 5. Additional utility APIs
app.get('/api/logs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const log = await Log.findOne({ id }).lean();
        
        if (!log) {
            return res.status(404).json({ error: 'Log not found' });
        }
        
        res.json({
            id: log.id,
            phone: log.phone,
            message: log.message,
            status: log.status,
            error_message: log.error_message,
            retry_count: log.retry_count,
            delivery_time: log.delivery_time,
            created_at: log.created_at.toISOString(),
            updated_at: log.updated_at.toISOString()
        });
    } catch (error) {
        console.error('❌ Error fetching log:', error.message);
        res.status(500).json({ error: 'Failed to fetch log' });
    }
});

app.delete('/api/logs', async (req, res) => {
    try {
        const { older_than_days = 30 } = req.query;
        
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - parseInt(older_than_days));
        
        const result = await Log.deleteMany({
            created_at: { $lt: cutoffDate }
        });
        
        res.json({
            message: `Deleted ${result.deletedCount} logs older than ${older_than_days} days`,
            deleted_count: result.deletedCount
        });
    } catch (error) {
        console.error('❌ Error deleting logs:', error.message);
        res.status(500).json({ error: 'Failed to delete logs' });
    }
});

// Test webhook endpoint
app.post('/api/test-webhook', async (req, res) => {
    try {
        const settings = await Settings.findOne();
        if (!settings || !settings.webhook_url) {
            return res.status(400).json({ error: 'Webhook URL not configured' });
        }
        
        const testPayload = {
            id: 'TEST_' + generateId(),
            phone: '6281234567890',
            status: 'success',
            message: 'Test webhook message',
            timestamp: new Date().toISOString()
        };
        
        const response = await fetch(settings.webhook_url, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'User-Agent': 'WhatsApp-OTP-Gateway/1.0'
            },
            body: JSON.stringify(testPayload),
            timeout: 10000
        });
        
        if (response.ok) {
            res.json({ 
                message: 'Webhook test successful',
                status_code: response.status 
            });
        } else {
            res.status(400).json({ 
                error: 'Webhook test failed',
                status_code: response.status,
                response_text: await response.text()
            });
        }
        
    } catch (error) {
        console.error('❌ Webhook test error:', error.message);
        res.status(500).json({ 
            error: 'Webhook test failed: ' + error.message 
        });
    }
});

// Health check with more details
app.get('/health', async (req, res) => {
    try {
        const dbStatus = mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
        const settings = await Settings.findOne();
        
        res.json({ 
            status: 'OK', 
            timestamp: new Date().toISOString(),
            whatsapp_connected: isConnected,
            phone_number: phoneNumber ? `+${phoneNumber}` : null,
            database_status: dbStatus,
            has_settings: !!settings,
            server_uptime: process.uptime(),
            memory_usage: process.memoryUsage(),
            retry_count: retryCount
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('❌ Unhandled error:', error);
    res.status(500).json({ 
        error: 'Internal server error',
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Endpoint not found',
        path: req.originalUrl 
    });
});

// --- Socket.IO Event Handlers ---
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    
    // Send current status immediately
    emitWhatsAppStatus();
    
    // Handle client requests for status update
    socket.on('request-status', () => {
        emitWhatsAppStatus();
    });
    
    socket.on('disconnect', (reason) => {
        console.log(`🔌 Client disconnected: ${socket.id}, reason: ${reason}`);
    });
    
    socket.on('error', (error) => {
        console.error(`❌ Socket error for ${socket.id}:`, error);
    });
});

// --- Initialize Application ---
async function startApplication() {
    try {
        // Connect to database
        await connectDB();
        
        // Ensure default settings exist
        const existingSettings = await Settings.findOne();
        if (!existingSettings) {
            const defaultSettings = new Settings({
                webhook_url: '',
                api_key: generateApiKey(),
                webhook_enabled: false,
                max_daily_messages: 1000
            });
            await defaultSettings.save();
            console.log('✅ Default settings created');
        }
        
        // Initialize WhatsApp
        setTimeout(() => {
            initializeWhatsApp();
        }, 2000); // Give some time for everything to settle
        
        console.log('✅ Application initialized successfully');
        
    } catch (error) {
        console.error('❌ Failed to initialize application:', error);
        process.exit(1);
    }
}

// --- Graceful Shutdown ---
async function gracefulShutdown(signal) {
    console.log(`👋 ${signal} signal received: Shutting down gracefully...`);
    
    try {
        // Close new connections
        server.close(() => {
            console.log('🚪 HTTP server closed');
        });
        
        // Close Socket.IO
        io.close(() => {
            console.log('🚪 Socket.IO server closed');
        });
        
        // Logout WhatsApp
        if (sock) {
            console.log('🚪 Logging out WhatsApp session...');
            try {
                await sock.logout();
                console.log('✅ WhatsApp session logged out');
            } catch (logoutError) {
                console.warn('⚠️ Error during WhatsApp logout:', logoutError.message);
            }
        }
        
        // Clear timers
        if (qrCodeTimer) {
            clearTimeout(qrCodeTimer);
        }
        
        // Close database connection
        if (mongoose.connection.readyState === 1) {
            console.log('🚪 Disconnecting from MongoDB...');
            await mongoose.disconnect();
            console.log('✅ MongoDB disconnected');
        }
        
        console.log('✅ Graceful shutdown completed');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error during graceful shutdown:', error);
        process.exit(1);
    }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('UNHANDLED_REJECTION');
});

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`🚀 WhatsApp OTP Gateway Backend running on port ${PORT}`);
    console.log(`🌐 Accessible from frontend at ${FRONTEND_URL}`);
    console.log(`📱 Socket.IO enabled for real-time updates`);
    
    // Start application initialization
    startApplication();
});

// Export for testing purposes
module.exports = { app, server, io };