"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.waManager = exports.WhatsAppManager = void 0;
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const pino_1 = __importDefault(require("pino"));
const qrcode_1 = __importDefault(require("qrcode"));
const qrcode_terminal_1 = __importDefault(require("qrcode-terminal"));
const fs_1 = __importDefault(require("fs"));
const config_1 = require("../config");
const db_1 = require("../storage/db");
const messageHandler_1 = require("./messageHandler");
class WhatsAppManager {
    sock = null;
    status = 'disconnected';
    currentQrDataUrl = null;
    user = null;
    isInitializing = false;
    constructor() {
        if (!fs_1.default.existsSync(config_1.CONFIG.AUTH_DIR)) {
            fs_1.default.mkdirSync(config_1.CONFIG.AUTH_DIR, { recursive: true });
        }
    }
    async start() {
        if (this.isInitializing)
            return;
        this.isInitializing = true;
        this.status = 'connecting';
        try {
            const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(config_1.CONFIG.AUTH_DIR);
            const { version } = await (0, baileys_1.fetchLatestBaileysVersion)().catch(() => ({ version: [2, 3000, 1015901307] }));
            const logger = (0, pino_1.default)({ level: 'silent' });
            this.sock = (0, baileys_1.default)({
                version,
                auth: state,
                logger,
                printQRInTerminal: false,
                browser: baileys_1.Browsers.ubuntu('Desktop'),
                syncFullHistory: false,
                generateHighQualityLinkPreview: true,
            });
            // Handle credentials update
            this.sock.ev.on('creds.update', saveCreds);
            // Handle connection updates
            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                if (qr) {
                    try {
                        this.currentQrDataUrl = await qrcode_1.default.toDataURL(qr);
                        console.log('\n=========================================');
                        console.log(' Scan the QR code below to connect WhatsApp:');
                        console.log(' (Or open the Web Dashboard in your browser)');
                        console.log('=========================================\n');
                        qrcode_terminal_1.default.generate(qr, { small: true });
                        db_1.db.log('INFO', 'New QR Code generated for WhatsApp pairing');
                    }
                    catch (e) {
                        console.error('Failed to generate QR data URL:', e);
                    }
                }
                if (connection === 'open') {
                    this.status = 'connected';
                    this.currentQrDataUrl = null;
                    this.isInitializing = false;
                    const rawId = this.sock?.user?.id || '';
                    const phone = rawId.split(':')[0] || rawId.split('@')[0];
                    this.user = {
                        id: rawId,
                        name: this.sock?.user?.name || undefined,
                        phone,
                    };
                    console.log(`\n>>> WhatsApp connection established! Logged in as: ${this.user.phone} (${this.user.name || 'User'}) <<<\n`);
                    db_1.db.log('INFO', `WhatsApp connected: ${this.user.phone}`, { user: this.user });
                }
                if (connection === 'close') {
                    this.status = 'disconnected';
                    this.isInitializing = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== baileys_1.DisconnectReason.loggedOut;
                    db_1.db.log('WARN', `WhatsApp disconnected: code ${statusCode}, reconnecting: ${shouldReconnect}`);
                    if (shouldReconnect) {
                        console.log('Reconnecting to WhatsApp in 5 seconds...');
                        setTimeout(() => {
                            this.start().catch((err) => console.error('Reconnect error:', err));
                        }, 5000);
                    }
                    else {
                        console.log('Session logged out or expired. Please re-scan QR code to log in.');
                        this.user = null;
                        this.currentQrDataUrl = null;
                    }
                }
            });
            // Handle incoming messages
            this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type === 'notify') {
                    for (const msg of messages) {
                        if (this.sock) {
                            await messageHandler_1.messageHandler.handleMessage(this.sock, msg).catch((err) => {
                                console.error('Message handler caught error:', err);
                            });
                        }
                    }
                }
            });
        }
        catch (err) {
            this.status = 'disconnected';
            this.isInitializing = false;
            console.error('Failed to initialize WhatsApp socket:', err);
            db_1.db.log('ERROR', 'Failed to initialize WhatsApp client', { error: err?.message });
        }
    }
    async sendMessage(recipient, text) {
        if (!this.sock || this.status !== 'connected') {
            throw new Error('WhatsApp is not connected');
        }
        let jid = recipient.trim();
        if (!jid.includes('@')) {
            const digits = jid.replace(/\D/g, '');
            jid = `${digits}@s.whatsapp.net`;
        }
        try {
            const result = await this.sock.sendMessage(jid, { text });
            if (result?.key?.id) {
                db_1.db.saveMessage({
                    id: result.key.id,
                    jid,
                    sender: this.sock.user?.id || 'bot',
                    sender_name: 'AI Automation',
                    content: text,
                    from_me: true,
                    is_group: jid.endsWith('@g.us'),
                    timestamp: Math.floor(Date.now() / 1000),
                    is_bot_reply: false,
                });
            }
            return true;
        }
        catch (err) {
            db_1.db.log('ERROR', `Failed to send manual/scheduled message to ${jid}`, { error: err?.message });
            throw err;
        }
    }
    getStatus() {
        return {
            status: this.status,
            qrCode: this.currentQrDataUrl,
            user: this.user,
            isConnected: this.status === 'connected',
        };
    }
    async logout() {
        try {
            if (this.sock) {
                await this.sock.logout();
            }
        }
        catch { }
        this.sock = null;
        this.status = 'disconnected';
        this.user = null;
        this.currentQrDataUrl = null;
        // Remove auth folder
        if (fs_1.default.existsSync(config_1.CONFIG.AUTH_DIR)) {
            fs_1.default.rmSync(config_1.CONFIG.AUTH_DIR, { recursive: true, force: true });
        }
        db_1.db.log('INFO', 'User logged out, session credentials cleared');
    }
    async restart() {
        if (this.sock) {
            try {
                this.sock.end(undefined);
            }
            catch { }
            this.sock = null;
        }
        this.status = 'disconnected';
        this.isInitializing = false;
        await this.start();
    }
}
exports.WhatsAppManager = WhatsAppManager;
exports.waManager = new WhatsAppManager();
