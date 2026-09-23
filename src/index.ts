import { CONFIG } from './config';
import { db } from './storage/db';
import { waManager } from './core/whatsapp';
import { messageScheduler } from './services/scheduler';
import { createServer } from './server/app';

async function bootstrap() {
  console.log('----------------------------------------------------');
  console.log('   WhatsApp AI Automation & Scheduling Controller   ');
  console.log('----------------------------------------------------');

  // Initialize scheduler with WhatsApp message sender
  messageScheduler.init(async (recipientJid: string, text: string) => {
    return waManager.sendMessage(recipientJid, text);
  });

  // Start WhatsApp connection
  console.log('[WhatsApp] Initializing Baileys client...');
  waManager.start().catch((err) => {
    console.error('[WhatsApp] Initialization error:', err);
  });

  // Start Web Server & Dashboard
  const app = createServer();
  const server = app.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`[Dashboard] Web Control Panel listening at http://localhost:${CONFIG.PORT}`);
    console.log(`[Dashboard] Open the URL above to configure AI prompts, rules, scan QR code, or schedule messages.`);
    db.log('INFO', `System started on port ${CONFIG.PORT}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[System] Received ${signal}. Shutting down gracefully...`);
    messageScheduler.stop();
    server.close(() => {
      console.log('[System] Web server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[Fatal] Failed to bootstrap application:', err);
  process.exit(1);
});
