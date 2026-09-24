import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import { db } from '../storage/db';
import { messageHandler } from './messageHandler';

export interface WhatsAppClientStatus {
  status: 'disconnected' | 'connecting' | 'connected';
  qrCode: string | null; // Data URL for web dashboard
  user: {
    id: string;
    name?: string;
    phone?: string;
  } | null;
  isConnected: boolean;
}

export class WhatsAppManager {
  private sock: WASocket | null = null;
  private status: WhatsAppClientStatus['status'] = 'disconnected';
  private currentQrDataUrl: string | null = null;
  private user: WhatsAppClientStatus['user'] = null;
  private isInitializing = false;

  constructor() {
    if (!fs.existsSync(CONFIG.AUTH_DIR)) {
      fs.mkdirSync(CONFIG.AUTH_DIR, { recursive: true });
    }
  }

  public clearAuth(): void {
    if (fs.existsSync(CONFIG.AUTH_DIR)) {
      try {
        fs.rmSync(CONFIG.AUTH_DIR, { recursive: true, force: true });
      } catch {
        try {
          const files = fs.readdirSync(CONFIG.AUTH_DIR);
          for (const file of files) {
            try {
              fs.rmSync(path.join(CONFIG.AUTH_DIR, file), { recursive: true, force: true });
            } catch {}
          }
        } catch {}
      }
    }
    if (!fs.existsSync(CONFIG.AUTH_DIR)) {
      fs.mkdirSync(CONFIG.AUTH_DIR, { recursive: true });
    }
  }

  public async start(): Promise<void> {
    if (this.isInitializing) return;
    this.isInitializing = true;
    this.status = 'connecting';

    try {
      const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] as any }));

      const logger = pino({ level: 'silent' });

      this.sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Desktop'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
      });

      // Handle credentials update
      this.sock.ev.on('creds.update', saveCreds);

      // Handle connection updates
      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.isInitializing = false;
          this.status = 'connecting';
          try {
            this.currentQrDataUrl = await qrcode.toDataURL(qr);
            console.log('\n=========================================');
            console.log(' Scan the QR code below to connect WhatsApp:');
            console.log(' (Or open the Web Dashboard in your browser)');
            console.log('=========================================\n');
            qrcodeTerminal.generate(qr, { small: true });
            db.log('INFO', 'New QR Code generated for WhatsApp pairing');
          } catch (e) {
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
          db.log('INFO', `WhatsApp connected: ${this.user.phone}`, { user: this.user });
        }

        if (connection === 'close') {
          this.status = 'disconnected';
          this.isInitializing = false;

          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === DisconnectReason.badSession;
          const shouldReconnect = !isLoggedOut;

          db.log('WARN', `WhatsApp disconnected: code ${statusCode}, reconnecting: ${shouldReconnect}`);

          if (shouldReconnect) {
            console.log('Reconnecting to WhatsApp in 5 seconds...');
            setTimeout(() => {
              this.start().catch((err) => console.error('Reconnect error:', err));
            }, 5000);
          } else {
            console.log('\n[WhatsApp] Session logged out or expired. Clearing credentials to generate a new QR code...');
            this.user = null;
            this.currentQrDataUrl = null;
            this.clearAuth();

            if (this.sock) {
              try {
                this.sock.ev.removeAllListeners('connection.update');
                this.sock.ev.removeAllListeners('creds.update');
                this.sock.ev.removeAllListeners('messages.upsert');
                this.sock.end(undefined);
              } catch {}
              this.sock = null;
            }

            // Immediately restart with blank auth so a fresh QR code is generated
            setTimeout(() => {
              this.start().catch((err) => console.error('Restart for QR code generation error:', err));
            }, 1000);
          }
        }
      });

      // Handle incoming messages
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
          for (const msg of messages) {
            if (this.sock) {
              await messageHandler.handleMessage(this.sock, msg).catch((err) => {
                console.error('Message handler caught error:', err);
              });
            }
          }
        }
      });
    } catch (err: any) {
      this.status = 'disconnected';
      this.isInitializing = false;
      console.error('Failed to initialize WhatsApp socket:', err);
      db.log('ERROR', 'Failed to initialize WhatsApp client', { error: err?.message });
    }
  }

  public async sendMessage(recipient: string, text: string): Promise<boolean> {
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
        db.saveMessage({
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
    } catch (err: any) {
      db.log('ERROR', `Failed to send manual/scheduled message to ${jid}`, { error: err?.message });
      throw err;
    }
  }

  public getStatus(): WhatsAppClientStatus {
    return {
      status: this.status,
      qrCode: this.currentQrDataUrl,
      user: this.user,
      isConnected: this.status === 'connected',
    };
  }

  public getSocket(): WASocket | null {
    return this.sock;
  }

  public getOwnerName(): string {
    if (process.env.OWNER_NAME && process.env.OWNER_NAME.trim()) {
      return process.env.OWNER_NAME.trim();
    }
    if (this.user?.name && this.user.name.trim()) {
      return this.user.name.trim();
    }
    return 'Chetan';
  }

  public async logout(): Promise<void> {
    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch {}

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.end(undefined);
      } catch {}
      this.sock = null;
    }

    this.status = 'disconnected';
    this.user = null;
    this.currentQrDataUrl = null;
    this.isInitializing = false;

    this.clearAuth();
    db.log('INFO', 'User logged out, session credentials cleared');

    // Automatically prepare a fresh QR code for the dashboard
    setTimeout(() => {
      this.start().catch((err) => console.error('Post-logout restart error:', err));
    }, 1000);
  }

  public async restart(forceNewSession = false): Promise<void> {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.end(undefined);
      } catch {}
      this.sock = null;
    }
    this.status = 'disconnected';
    this.isInitializing = false;
    this.user = null;
    this.currentQrDataUrl = null;

    if (forceNewSession) {
      this.clearAuth();
    }

    await this.start();
  }
}

export const waManager = new WhatsAppManager();
