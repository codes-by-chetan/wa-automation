"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const db_1 = require("./storage/db");
const whatsapp_1 = require("./core/whatsapp");
const scheduler_1 = require("./services/scheduler");
const app_1 = require("./server/app");
async function bootstrap() {
    console.log('----------------------------------------------------');
    console.log('   WhatsApp AI Automation & Scheduling Controller   ');
    console.log('----------------------------------------------------');
    // Initialize scheduler with WhatsApp message sender
    scheduler_1.messageScheduler.init(async (recipientJid, text) => {
        return whatsapp_1.waManager.sendMessage(recipientJid, text);
    });
    // Start WhatsApp connection
    console.log('[WhatsApp] Initializing Baileys client...');
    whatsapp_1.waManager.start().catch((err) => {
        console.error('[WhatsApp] Initialization error:', err);
    });
    // Start Web Server & Dashboard
    const app = (0, app_1.createServer)();
    const server = app.listen(config_1.CONFIG.PORT, config_1.CONFIG.HOST, () => {
        console.log(`[Dashboard] Web Control Panel listening at http://localhost:${config_1.CONFIG.PORT}`);
        console.log(`[Dashboard] Open the URL above to configure AI prompts, rules, scan QR code, or schedule messages.`);
        db_1.db.log('INFO', `System started on port ${config_1.CONFIG.PORT}`);
    });
    // Graceful shutdown
    const shutdown = async (signal) => {
        console.log(`\n[System] Received ${signal}. Shutting down gracefully...`);
        scheduler_1.messageScheduler.stop();
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
