"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const db_1 = require("../storage/db");
const whatsapp_1 = require("../core/whatsapp");
const llm_1 = require("../services/llm");
const scheduler_1 = require("../services/scheduler");
function createServer() {
    const app = (0, express_1.default)();
    const publicDir = fs_1.default.existsSync(path_1.default.resolve(__dirname, 'public'))
        ? path_1.default.resolve(__dirname, 'public')
        : path_1.default.resolve(process.cwd(), 'src', 'server', 'public');
    app.use((0, cors_1.default)());
    app.use(express_1.default.json());
    app.use(express_1.default.static(publicDir));
    // 1. WhatsApp Connection Status
    app.get('/api/status', (_req, res) => {
        res.json(whatsapp_1.waManager.getStatus());
    });
    app.post('/api/reconnect', async (_req, res) => {
        try {
            await whatsapp_1.waManager.restart();
            res.json({ success: true, message: 'Reconnecting WhatsApp...' });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
    app.post('/api/logout', async (_req, res) => {
        try {
            await whatsapp_1.waManager.logout();
            res.json({ success: true, message: 'Logged out successfully' });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
    // 2. Settings Endpoints
    app.get('/api/settings', (_req, res) => {
        const settings = db_1.db.getSettings();
        res.json(settings);
    });
    app.post('/api/settings', (req, res) => {
        try {
            const updated = db_1.db.updateSettings(req.body);
            db_1.db.log('INFO', 'Settings updated via Web Dashboard');
            res.json({ success: true, settings: updated });
        }
        catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });
    // 3. Test LLM Endpoint
    app.post('/api/test-llm', async (req, res) => {
        const { baseUrl, apiKey, model, systemPrompt, sampleMessage } = req.body;
        const result = await llm_1.llmService.testCompletion(baseUrl, apiKey, model, systemPrompt, sampleMessage);
        res.json(result);
    });
    // 4. Schedules Endpoints
    app.get('/api/schedules', (_req, res) => {
        const schedules = db_1.db.getSchedules();
        res.json(schedules);
    });
    app.post('/api/schedules', (req, res) => {
        const { recipient, message, scheduledAt, cronExpression, contextNote } = req.body;
        if (!recipient || !message) {
            return res.status(400).json({ success: false, error: 'Recipient and message are required' });
        }
        try {
            const schedule = scheduler_1.messageScheduler.addSchedule({
                recipient,
                message,
                scheduledAt: scheduledAt || null,
                cronExpression: cronExpression || null,
                contextNote: contextNote || null,
            });
            db_1.db.log('INFO', `Created new schedule for ${recipient}`, { scheduleId: schedule.id });
            res.json({ success: true, schedule });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
    app.delete('/api/schedules/:id', (req, res) => {
        const scheduleId = String(req.params.id);
        const success = scheduler_1.messageScheduler.deleteSchedule(scheduleId);
        if (success) {
            res.json({ success: true, message: 'Schedule removed' });
        }
        else {
            res.status(404).json({ success: false, error: 'Schedule not found' });
        }
    });
    app.post('/api/schedules/:id/run', async (req, res) => {
        const schedules = db_1.db.getSchedules();
        const scheduleId = String(req.params.id);
        const item = schedules.find((s) => s.id === scheduleId);
        if (!item) {
            return res.status(404).json({ success: false, error: 'Schedule not found' });
        }
        const success = await scheduler_1.messageScheduler.dispatchScheduledMessage(item);
        res.json({ success, message: success ? 'Dispatched' : 'Failed to dispatch' });
    });
    // 5. Send one-off immediate message
    app.post('/api/send', async (req, res) => {
        const { recipient, message, contextNote } = req.body;
        if (!recipient || !message) {
            return res.status(400).json({ success: false, error: 'Recipient and message are required' });
        }
        try {
            await whatsapp_1.waManager.sendMessage(recipient, message);
            if (contextNote && contextNote.trim().length > 0) {
                const jid = scheduler_1.messageScheduler.formatJid(recipient);
                db_1.db.setCampaignContext(jid, message, contextNote.trim());
            }
            res.json({ success: true, message: 'Message sent successfully' });
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
    // 6. Recent chats & messages
    app.get('/api/chats', (_req, res) => {
        const chats = db_1.db.getRecentChats(50);
        res.json(chats);
    });
    app.get('/api/chats/:jid/messages', (req, res) => {
        const jid = String(req.params.jid);
        const messages = db_1.db.getRecentMessages(jid, 30);
        const campaignContext = db_1.db.getActiveCampaignContext(jid);
        res.json({ messages, campaignContext });
    });
    // 7. System Logs
    app.get('/api/logs', (_req, res) => {
        const logs = db_1.db.getLogs(60);
        res.json(logs);
    });
    app.post('/api/logs/clear', (_req, res) => {
        db_1.db.clearLogs();
        res.json({ success: true });
    });
    // Fallback to index.html for SPA
    app.use((_req, res) => {
        res.sendFile(path_1.default.resolve(publicDir, 'index.html'));
    });
    return app;
}
