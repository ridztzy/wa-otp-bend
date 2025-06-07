const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

let sock;
let qrCodeData = null;
let isConnected = false;
let phoneNumber = null;
let isInitializing = false;
let isInitialized = false; // Track if service has been initialized
let io; // Socket.IO instance
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Emits the current WhatsApp connection status via Socket.IO.
 */
function emitWhatsAppStatus() {
    if (io) {
        io.emit('whatsapp-status', {
            whatsapp_connected: isConnected,
            phone_number: phoneNumber ? `+${phoneNumber}` : null,
            qr_available: !!qrCodeData,
            qrcode: qrCodeData,
            reconnect_attempts: reconnectAttempts,
            initialized: isInitialized
        });
    }
}

/**
 * Prepare WhatsApp service without initializing connection
 * @param {object} socketIo - The Socket.IO instance to emit status updates.
 */
async function prepareWhatsApp(socketIo) {
    io = socketIo;
    console.log('📱 WhatsApp service prepared, waiting for initialization request');
}

/**
 * Initializes the WhatsApp connection using Baileys.
 * This function is called when frontend requests initialization
 */
async function initializeWhatsApp() {
    // Prevent multiple simultaneous initializations
    if (isInitializing) {
        console.log('🔄 WhatsApp already initializing...');
        return { success: false, message: 'Already initializing' };
    }
    
    // If already connected, return success
    if (isConnected) {
        return { success: true, message: 'Already connected' };
    }
    
    isInitializing = true;
    console.log('🔄 Initializing WhatsApp connection...');
    
    try {
        // Load or create authentication state
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
        
        // Cleanup existing connection if it's still open
        if (sock && sock.ws && sock.ws.readyState === sock.ws.OPEN) {
            try {
                await sock.logout();
                console.log('✅ Existing socket logged out.');
            } catch (error) {
                console.log('⚠️ Error during logout of existing socket:', error.message);
            }
        }
        
        // Create a new WhatsApp socket instance
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // QR will be emitted via Socket.IO
            browser: [
                'WA OTP Gateway', // Custom browser name
                'Chrome',
                String(Date.now()) // Unique timestamp for browser fingerprint
            ],
            markOnlineOnConnect: false, // Do not mark online automatically
            getMessage: async (key) => ({}), // Placeholder for message retrieval (can be extended)
            // Additional options for stability and reliability
            defaultQueryTimeoutMs: 60000, // Timeout for queries
            connectTimeoutMs: 60000,     // Timeout for initial connection
            keepAliveIntervalMs: 30000,  // Interval for keep-alive pings
            emitOwnEvents: false,        // Do not emit own events (can be set to true for debugging)
            shouldSyncHistoryMessage: false, // Do not sync message history
            maxMsgRetryCount: 3          // Max retries for sending messages
        });
        
        // Register event listeners for connection updates and credential saves
        sock.ev.on('connection.update', handleConnectionUpdate);
        sock.ev.on('creds.update', saveCreds);
        
        // Handle general socket errors
        sock.ev.on('error', (error) => {
            console.error('🚨 WhatsApp Socket Error:', error);
        });
        
        isInitialized = true;
        return { success: true, message: 'WhatsApp initialization started' };
        
    } catch (error) {
        // Log detailed error information for debugging
        console.error('❌ Error initializing WhatsApp:', error.message);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
        if (error.output && error.output.payload) { // For Boom errors from Baileys
            console.error('Error payload:', error.output.payload);
        }
        
        resetConnectionState();
        
        // Retry initialization after delay if max attempts not reached
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`🔄 Retrying initialization (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in 10 seconds...`);
            setTimeout(() => {
                initializeWhatsApp();
            }, 10000);
        } else {
            console.error('❌ Max reconnect attempts reached. Manual intervention required.');
            reconnectAttempts = 0; // Reset for next manual attempt
        }
        
        return { success: false, error: error.message };
    } finally {
        isInitializing = false;
    }
}

/**
 * Handles updates to the WhatsApp connection status.
 * @param {object} update - The connection update object from Baileys.
 */
async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    
    // If QR code is available, generate and emit it
    if (qr) {
        qrCodeData = await QRCode.toDataURL(qr);
        console.log('✅ QR Code generated');
        emitWhatsAppStatus();
    }
    if (update?.node?.userAgent) {
        lastDeviceInfo = update.node.userAgent;
        console.log('ℹ️ Device info from update.node.userAgent:', lastDeviceInfo);
    } else if (update?.userAgent) {
        lastDeviceInfo = update.userAgent;
        console.log('ℹ️ Device info from update.userAgent:', lastDeviceInfo);
    }
    // Handle connection closure
    if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
        
        console.log(`Connection closed: ${errorMessage} (Code: ${statusCode})`);
        
        resetConnectionState(); // Reset global connection state
        
        
        // Determine action based on disconnect reason
        switch (statusCode) {
            case DisconnectReason.badSession:
            case DisconnectReason.loggedOut:
                console.log('🔄 Session invalid or logged out, clearing auth and restarting...');
                await clearAuthAndRestart(); // Clear session and restart immediately
                break;
                
            case DisconnectReason.restartRequired:
                console.log('🔄 Restart required, restarting connection...');
                scheduleReconnect(1000); // Short delay for restart
                break;
                
            case 515: // Stream error - common after pairing
                console.log('🔄 Stream error 515 (post-pairing)');
                // If 515 error persists for multiple attempts, clear session and restart
                if (reconnectAttempts >= Math.floor(MAX_RECONNECT_ATTEMPTS / 2)) { 
                    console.log('⚠️ Too many 515 errors, clearing auth and restarting...');
                    await clearAuthAndRestart();
                } else {
                    console.log('🔄 Attempting reconnect...');
                    scheduleReconnect(3000); // Regular reconnect delay for 515
                }
                break;
                
            case DisconnectReason.connectionClosed:
            case DisconnectReason.connectionLost:
            case DisconnectReason.connectionReplaced:
            case DisconnectReason.timedOut:
            default:
                console.log(`🔄 Disconnect reason: ${errorMessage} (${statusCode}), attempting reconnect...`);
                scheduleReconnect(5000); // Default reconnect delay
                break;
        }
    } else if (connection === 'open') {
        // Handle successful connection


        console.log('🎉 WhatsApp connected successfully');
        isConnected = true;
        phoneNumber = sock.user?.id?.split(':')[0] || null;
        qrCodeData = null; // Clear QR data once connected
        reconnectAttempts = 0; // Reset reconnect counter on successful connection
        emitWhatsAppStatus();

        // --- BLOK KODE YANG HARUS KAMU GANTI / PERBAIKI ---
        // Kita akan tambahkan penundaan untuk memberi waktu data sock.user terisi.
        setTimeout(() => {
            if (sock && sock.user) {
                if (sock.user.userAgent) {
                    lastDeviceInfo = sock.user.userAgent;
                    console.log('✅ Device info retrieved from sock.user.userAgent (after delay):', lastDeviceInfo);
                } else if (sock.user.browser) {
                    // Fallback jika userAgent tidak ada di sock.user.userAgent,
                    // tapi ada di sock.user.browser (struktur array)
                    lastDeviceInfo = {
                        platform: sock.user.browser[0] || 'Unknown',
                        browser: sock.user.browser[1] || 'Unknown',
                        appVersion: {
                            primary: parseInt(sock.user.browser[2]?.split('.')[0]) || 0,
                            secondary: parseInt(sock.user.browser[2]?.split('.')[1]) || 0,
                            tertiary: parseInt(sock.user.browser[2]?.split('.')[2]) || 0,
                        },
                        device: 'Desktop', // Ini bisa disesuaikan atau diambil dari sock.user.platform/device jika ada
                    };
                    console.log('ℹ️ Device info fallback from sock.user.browser (after delay):', lastDeviceInfo);
                } else {
                    console.warn('⚠️ User agent (device info) still not found in sock.user after delay. lastDeviceInfo remains null or incomplete.');
                    lastDeviceInfo = null;
                }
            } else {
                console.warn('⚠️ sock or sock.user is null/undefined after delay. Cannot retrieve device info.');
                lastDeviceInfo = null;
            }

            // Opsional: Coba panggil getDeviceInfo() di sini untuk melihat hasilnya
            // const currentDeviceInfo = getDeviceInfo();
            // console.log('Current Device Info (after delay and setting lastDeviceInfo):', currentDeviceInfo);

        }, 500); // Tunda selama 500 milidetik (setengah detik)
        // --- AKHIR BLOK KODE YANG HARUS KAMU GANTI / PERBAIKI ---


        // Optional: Check if creds.json exists after successful connection
        if (!fs.existsSync('./auth_info/creds.json')) {
            console.warn('⚠️ creds.json not found after successful connection. This might indicate an issue with saveCreds or initial setup.');
        }
    } else if (connection === 'connecting') {
        console.log('🔄 Connecting to WhatsApp...');
    }
}


/**
 * Schedules a reconnect attempt after a specified delay.
 * Prevents continuous reconnect attempts if max attempts are reached.
 * @param {number} delay - The delay in milliseconds before attempting reconnect.
 */
function scheduleReconnect(delay = 5000) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Max reconnect attempts reached. Please check your connection or restart manually.');
        reconnectAttempts = 0; // Reset for next manual attempt
        return;
    }
    
    setTimeout(() => {
        // Only attempt reconnect if not already initializing and not connected
        if (!isInitializing && !isConnected) {
            reconnectAttempts++;
            console.log(`🔄 Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
            initializeWhatsApp();
        }
    }, delay);
}

/**
 * Clears the authentication information and triggers a restart of the connection.
 */
async function clearAuthAndRestart() {
    try {
        const authInfoPath = path.resolve(__dirname, '../auth_info');
        if (fs.existsSync(authInfoPath)) {
            await fs.promises.rm(authInfoPath, { recursive: true, force: true });
            console.log('🗑️ Auth info cleared');
        }
        scheduleReconnect(2000); // Attempt reconnect after clearing auth
    } catch (error) {
        console.error('❌ Error clearing auth:', error);
        scheduleReconnect(5000); // Retry with longer delay on error
    }
}

/**
 * Resets the internal connection state variables.
 */
function resetConnectionState() {
    isConnected = false;
    phoneNumber = null;
    qrCodeData = null;
    emitWhatsAppStatus(); // Emit updated status
}

/**
 * Sends a text message to a specified phone number.
 * @param {string} phone - The recipient's phone number (e.g., "628123456789").
 * @param {string} message - The text message to send.
 * @returns {object} - An object indicating success or failure.
 */
async function sendMessage(phone, message) {
    try {
        if (!isConnected || !sock) {
            throw new Error('WhatsApp not connected');
        }
        
        const jid = phone + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        return { success: true };
    } catch (error) {
        console.error('❌ Error sending message:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Disconnects the WhatsApp session and clears authentication information.
 */
async function disconnect() {
    try {
        reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
        
        if (sock && sock.ws && sock.ws.readyState === sock.ws.OPEN) {
            await sock.logout();
            console.log('✅ WhatsApp socket logged out.');
        }
        sock = null; // Clear socket instance
        
        const authInfoPath = path.resolve(__dirname, '../auth_info');
        if (fs.existsSync(authInfoPath)) {
            await fs.promises.rm(authInfoPath, { recursive: true, force: true });
            console.log('🗑️ Auth info cleared during disconnect.');
        }
        
        resetConnectionState();
        isInitialized = false; // Reset initialization status
        reconnectAttempts = 0; // Reset after successful disconnect
        return { success: true };
    } catch (error) {
        console.error('❌ Error disconnecting:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Forces a refresh of the QR code by clearing the session and re-initializing.
 * Only works if not already connected.
 */
async function refreshQR() {
    try {
        if (isConnected) {
            throw new Error('Already connected, cannot refresh QR.');
        }
        
        reconnectAttempts = 0; // Reset counter for fresh QR attempt
        
        const authInfoPath = path.resolve(__dirname, '../auth_info');
        if (fs.existsSync(authInfoPath)) {
            await fs.promises.rm(authInfoPath, { recursive: true, force: true });
            console.log('🗑️ Auth info cleared for QR refresh.');
        }
        
        await initializeWhatsApp();
        return { success: true };
    } catch (error) {
        console.error('❌ Error refreshing QR:', error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Performs cleanup tasks, primarily logging out the socket.
 */
async function cleanup() {
    try {
        reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent reconnect during cleanup
        if (sock && sock.ws && sock.ws.readyState === sock.ws.OPEN) {
            await sock.logout();
            console.log('✅ Socket logged out during cleanup.');
        }
    } catch (error) {
        console.log('⚠️ Error during cleanup:', error.message);
    }
}

/**
 * Returns the current status of the WhatsApp connection.
 * @returns {object} - Object containing connection status details.
 */
function getStatus() {
    return {
        connected: isConnected,
        phone_number: phoneNumber ? `+${phoneNumber}` : null,
        qr_available: !!qrCodeData,
        qrcode: qrCodeData,
        reconnect_attempts: reconnectAttempts,
        max_attempts: MAX_RECONNECT_ATTEMPTS,
        initialized: isInitialized
    };
}

/**
 * Forces a full re-initialization of the WhatsApp connection, clearing session and attempting a fresh start.
 */
async function forceReconnect() {
    try {
        reconnectAttempts = 0; // Reset attempts for a fresh force reconnect
        if (sock) {
            try {
                await sock.logout();
                console.log('✅ Existing socket logged out for force reconnect.');
            } catch (error) {
                console.log('⚠️ Error during logout for force reconnect:', error.message);
            }
        }
        sock = null; // Clear socket instance
        resetConnectionState(); // Reset global connection state
        await initializeWhatsApp(); // Start a new initialization
        return { success: true };
    } catch (error) {
        console.error('❌ Error force reconnecting:', error.message);
        return { success: false, error: error.message };
    }
}

const LOGIN_HISTORY_PATH = path.resolve(__dirname, './login_history.json');

/**
 * Save login/disconnect activity to history file.
 * @param {object} entry - { action, success, ip_address, user_agent, timestamp, details }
 */
async function saveLoginHistory(entry) {
  let history = [];
  try {
    if (fs.existsSync(LOGIN_HISTORY_PATH)) {
      const raw = await fs.promises.readFile(LOGIN_HISTORY_PATH, 'utf-8');
      history = JSON.parse(raw);
    }
  } catch (e) {
    history = [];
  }
  history.unshift(entry); // add to front
  // Limit history to 1000 entries
  if (history.length > 1000) history = history.slice(0, 1000);
  await fs.promises.writeFile(LOGIN_HISTORY_PATH, JSON.stringify(history, null, 2));
}

/**
 * Get login/disconnect history.
 * @param {number} limit
 * @param {number} offset
 * @returns {Array}
 */
function getLoginHistory(limit = 10, offset = 0) {
  try {
    if (fs.existsSync(LOGIN_HISTORY_PATH)) {
      const raw = fs.readFileSync(LOGIN_HISTORY_PATH, 'utf-8');
      const history = JSON.parse(raw);
      return history.slice(offset, offset + limit);
    }
    return [];
  } catch (e) {
    return [];
  }
}
let lastDeviceInfo = null; // Tambahkan di atas
/**
 * Mendeteksi jenis perangkat berdasarkan ID pengguna WhatsApp
 * @param {string} id - ID WhatsApp pengguna
 * @returns {string} - Jenis perangkat ('android', 'ios', 'web', 'desktop', atau 'unknown')
 */
function getDeviceType(id) {
    if (!id) return 'unknown';

    // Pola regex untuk berbagai jenis perangkat
    const devicePatterns = {
        ios: /^3A[0-9A-F]{18}$/i,      // Pola untuk iOS
        web: /^3E[0-9A-F]{20}$/i,      // Pola untuk Web
        android: /^([0-9A-F]{21}|[0-9A-F]{32})$/i,  // Pola untuk Android
        desktop: /^(3F|[0-9A-F]{18})$/i // Pola untuk Desktop
    };

    // Cek setiap pola dan kembalikan jenis perangkat
    for (const [device, pattern] of Object.entries(devicePatterns)) {
        if (pattern.test(id)) return device;
    }

    return 'unknown';
}

/**
 * Mendapatkan informasi detail perangkat yang terhubung
 * @returns {object} - Informasi perangkat
 */
function getDeviceInfo() {
    if (!isConnected || !sock?.user) {
        return {
            jenis_perangkat: 'unknown',
            platform: 'Unknown',
            browser: 'Unknown',
            versi_wa: 'Unknown',
            id_perangkat: 'Unknown',
            user_agent: 'Unknown',
            waktu_terhubung: null
        };
    }

    const deviceId = sock.user.id;
    const deviceType = getDeviceType(deviceId);
    const userAgent = lastDeviceInfo || {};

    return {
        jenis_perangkat: deviceType,
        platform: userAgent.platform || 'Unknown',
        browser: userAgent.browser || 'Unknown',
        versi_wa: userAgent.version || 'Unknown',
        id_perangkat: deviceId,
        user_agent: JSON.stringify(userAgent),
        waktu_terhubung: new Date().toISOString()
    };
}

module.exports = {
    prepareWhatsApp,
    initializeWhatsApp,
    sendMessage,
    disconnect,
    refreshQR,
    getStatus,
    cleanup,
    forceReconnect,
    getDeviceInfo,
    saveLoginHistory,
  getLoginHistory,
};