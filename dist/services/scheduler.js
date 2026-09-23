"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageScheduler = exports.MessageScheduler = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const db_1 = require("../storage/db");
class MessageScheduler {
    sendMessageFn = null;
    cronTasks = new Map();
    checkInterval = null;
    init(sendMessageFn) {
        this.sendMessageFn = sendMessageFn;
        // Start background poller for one-time pending schedules (every 10 seconds)
        if (!this.checkInterval) {
            this.checkInterval = setInterval(() => {
                this.processDueSchedules().catch((err) => {
                    console.error('[Scheduler] Error processing due schedules:', err);
                });
            }, 10000);
        }
        // Load active cron schedules
        this.reloadCronSchedules();
    }
    stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        for (const [id, task] of this.cronTasks.entries()) {
            task.stop();
        }
        this.cronTasks.clear();
    }
    /**
     * Reload all recurring cron jobs from the database
     */
    reloadCronSchedules() {
        // Stop all current cron tasks
        for (const [, task] of this.cronTasks.entries()) {
            task.stop();
        }
        this.cronTasks.clear();
        const activeCrons = db_1.db.getSchedules('active_cron');
        for (const item of activeCrons) {
            if (item.cron_expression && node_cron_1.default.validate(item.cron_expression)) {
                try {
                    const task = node_cron_1.default.schedule(item.cron_expression, async () => {
                        await this.dispatchScheduledMessage(item);
                    });
                    this.cronTasks.set(item.id, task);
                }
                catch (e) {
                    console.error(`[Scheduler] Invalid cron for ${item.id}:`, e);
                }
            }
        }
    }
    /**
     * Check and dispatch any one-off schedules that are due
     */
    async processDueSchedules() {
        if (!this.sendMessageFn)
            return;
        const nowIso = new Date().toISOString();
        const dueItems = db_1.db.getPendingDueSchedules(nowIso);
        for (const item of dueItems) {
            await this.dispatchScheduledMessage(item);
        }
    }
    /**
     * Format phone number or JID to standard WhatsApp JID
     */
    formatJid(recipient) {
        const trimmed = recipient.trim();
        if (trimmed.includes('@'))
            return trimmed;
        const digits = trimmed.replace(/\D/g, '');
        return `${digits}@s.whatsapp.net`;
    }
    /**
     * Dispatch a scheduled message and register follow-up reply context
     */
    async dispatchScheduledMessage(item) {
        if (!this.sendMessageFn) {
            db_1.db.log('WARN', `Cannot send schedule ${item.id}: WhatsApp client not ready`);
            return false;
        }
        const jid = this.formatJid(item.recipient);
        try {
            db_1.db.log('INFO', `Dispatching scheduled message to ${jid}`, { scheduleId: item.id, message: item.message });
            const success = await this.sendMessageFn(jid, item.message);
            if (success) {
                if (!item.cron_expression) {
                    db_1.db.updateScheduleStatus(item.id, 'completed');
                }
                else {
                    db_1.db.updateScheduleStatus(item.id, 'active_cron');
                }
                // If a context note was provided, activate campaign context so replies get special handling
                if (item.context_note && item.context_note.trim().length > 0) {
                    db_1.db.setCampaignContext(jid, item.message, item.context_note.trim(), item.id);
                    db_1.db.log('INFO', `Activated follow-up reply context for ${jid}`, { contextNote: item.context_note });
                }
                return true;
            }
            else {
                db_1.db.updateScheduleStatus(item.id, item.cron_expression ? 'active_cron' : 'failed', 'Socket send returned false');
                return false;
            }
        }
        catch (err) {
            const errorMsg = err?.message || String(err);
            db_1.db.log('ERROR', `Failed to dispatch schedule ${item.id}`, { error: errorMsg });
            db_1.db.updateScheduleStatus(item.id, item.cron_expression ? 'active_cron' : 'failed', errorMsg);
            return false;
        }
    }
    /**
     * Add a new schedule
     */
    addSchedule(options) {
        const id = 'sch_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
        const item = db_1.db.createSchedule({
            id,
            recipient: options.recipient,
            message: options.message,
            scheduled_at: options.scheduledAt,
            cron_expression: options.cronExpression,
            context_note: options.contextNote,
        });
        if (item.cron_expression) {
            this.reloadCronSchedules();
        }
        return item;
    }
    /**
     * Delete or cancel a schedule
     */
    deleteSchedule(id) {
        const task = this.cronTasks.get(id);
        if (task) {
            task.stop();
            this.cronTasks.delete(id);
        }
        return db_1.db.deleteSchedule(id);
    }
}
exports.MessageScheduler = MessageScheduler;
exports.messageScheduler = new MessageScheduler();
