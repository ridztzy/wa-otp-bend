const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

let sock;
let qrCodeData = null;
let isConnected = false;
let phoneNumber = null;
let isInitializing = false;
let io; // Socket.IO instance
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Emits the current WhatsApp connection status via Socket.IO.
 */
function emitWhatsAppStatus() {
    if (io) {
        io.emit('whatsapp-status', {
            connected: isConnected,
            phone_number: phoneNumber ? `+${phoneNumber}` : null,
            qr_available: !!qrCodeData,
            qrcode: qrCodeData,
            reconnect_attempts: reconnectAttempts
        });
    }
}

/**
 * Initializes the WhatsApp connection using Baileys.
 * @param {object} socketIo - The Socket.IO instance to emit status updates.
 */
async function initializeWhatsApp(socketIo) {
    // Prevent multiple simultaneous initializations
    if (isInitializing) {
        console.log('🔄 WhatsApp already initializing...');
        return;
    }
    
    io = socketIo;
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
                initializeWhatsApp(io);
            }, 10000);
        } else {
            console.error('❌ Max reconnect attempts reached. Manual intervention required.');
            reconnectAttempts = 0; // Reset for next manual attempt
        }
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
            initializeWhatsApp(io);
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
        
        await initializeWhatsApp(io);
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
        max_attempts: MAX_RECONNECT_ATTEMPTS
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
        await initializeWhatsApp(io); // Start a new initialization
        return { success: true };
    } catch (error) {
        console.error('❌ Error force reconnecting:', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    initializeWhatsApp,
    sendMessage,
    disconnect,
    refreshQR,
    getStatus,
    cleanup,
    forceReconnect
};
