"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = __importDefault(require("fs"));
const config_1 = require("../config");
class StorageDB {
    db;
    constructor() {
        if (!fs_1.default.existsSync(config_1.CONFIG.DATA_DIR)) {
            fs_1.default.mkdirSync(config_1.CONFIG.DATA_DIR, { recursive: true });
        }
        this.db = new better_sqlite3_1.default(config_1.CONFIG.DB_PATH);
        this.db.pragma('journal_mode = WAL');
        this.initTables();
    }
    initTables() {
        // Settings table
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
        // Messages history table
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT,
        content TEXT NOT NULL,
        from_me INTEGER NOT NULL,
        is_group INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        is_bot_reply INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_messages_jid_timestamp ON messages(jid, timestamp DESC);
    `);
        // Schedules table
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        recipient TEXT NOT NULL,
        message TEXT NOT NULL,
        scheduled_at TEXT,
        cron_expression TEXT,
        context_note TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        last_executed_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_status ON schedules(status);
    `);
        // Follow-up campaign contexts table
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_contexts (
        id TEXT PRIMARY KEY,
        recipient_jid TEXT NOT NULL,
        initial_message TEXT NOT NULL,
        context_note TEXT NOT NULL,
        scheduled_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_jid_active ON campaign_contexts(recipient_jid, active);
    `);
        // System logs table
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(id DESC);
    `);
        this.initDefaultSettings();
    }
    initDefaultSettings() {
        const defaults = {
            llm_base_url: config_1.CONFIG.DEFAULT_LLM_BASE_URL,
            llm_api_key: config_1.CONFIG.DEFAULT_LLM_API_KEY,
            llm_model: config_1.CONFIG.DEFAULT_LLM_MODEL,
            system_prompt: config_1.CONFIG.DEFAULT_SYSTEM_PROMPT,
            target_mode: 'contacts_only',
            whitelist: [],
            blacklist: [],
            cooldown_seconds: 5,
            typing_simulation: true,
            history_limit: 10,
            scheduled_reply_mode: 'reply_with_context',
        };
        const selectStmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
        const insertStmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
        for (const [key, val] of Object.entries(defaults)) {
            const existing = selectStmt.get(key);
            if (!existing) {
                insertStmt.run(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
            }
        }
    }
    // --- Settings ---
    getSettings() {
        const rows = this.db.prepare('SELECT key, value FROM settings').all();
        const result = {};
        for (const row of rows) {
            if (['whitelist', 'blacklist'].includes(row.key)) {
                try {
                    result[row.key] = JSON.parse(row.value);
                }
                catch {
                    result[row.key] = [];
                }
            }
            else if (['cooldown_seconds', 'history_limit'].includes(row.key)) {
                result[row.key] = parseInt(row.value, 10) || 5;
            }
            else if (['typing_simulation'].includes(row.key)) {
                result[row.key] = row.value === 'true' || row.value === '1';
            }
            else {
                result[row.key] = row.value;
            }
        }
        return result;
    }
    updateSettings(updates) {
        const stmt = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
        const updateTx = this.db.transaction((items) => {
            for (const [key, val] of items) {
                const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
                stmt.run(key, strVal);
            }
        });
        updateTx(Object.entries(updates));
        return this.getSettings();
    }
    // --- Messages & Memory ---
    saveMessage(msg) {
        const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, jid, sender, sender_name, content, from_me, is_group, timestamp, is_bot_reply
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(msg.id, msg.jid, msg.sender, msg.sender_name || null, msg.content, msg.from_me ? 1 : 0, msg.is_group ? 1 : 0, msg.timestamp, msg.is_bot_reply ? 1 : 0);
    }
    getRecentMessages(jid, limit = 10) {
        const stmt = this.db.prepare(`
      SELECT * FROM messages 
      WHERE jid = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);
        const rows = stmt.all(jid, limit);
        // Reverse so it's in chronological order
        return rows.reverse().map((r) => ({
            id: r.id,
            jid: r.jid,
            sender: r.sender,
            sender_name: r.sender_name,
            content: r.content,
            from_me: Boolean(r.from_me),
            is_group: Boolean(r.is_group),
            timestamp: r.timestamp,
            is_bot_reply: Boolean(r.is_bot_reply),
        }));
    }
    getLastBotReplyTime(jid) {
        const stmt = this.db.prepare(`
      SELECT timestamp FROM messages 
      WHERE jid = ? AND is_bot_reply = 1 
      ORDER BY timestamp DESC LIMIT 1
    `);
        const row = stmt.get(jid);
        return row ? row.timestamp : null;
    }
    getRecentChats(limit = 20) {
        const stmt = this.db.prepare(`
      SELECT m.jid, m.sender_name, m.content as last_content, m.timestamp, m.is_group
      FROM messages m
      INNER JOIN (
        SELECT jid, MAX(timestamp) as max_time
        FROM messages
        GROUP BY jid
      ) latest ON m.jid = latest.jid AND m.timestamp = latest.max_time
      ORDER BY m.timestamp DESC
      LIMIT ?
    `);
        return stmt.all(limit);
    }
    // --- Schedules ---
    createSchedule(item) {
        const fullItem = {
            ...item,
            status: item.status || (item.cron_expression ? 'active_cron' : 'pending'),
            created_at: new Date().toISOString(),
        };
        const stmt = this.db.prepare(`
      INSERT INTO schedules (
        id, recipient, message, scheduled_at, cron_expression, context_note, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
        stmt.run(fullItem.id, fullItem.recipient, fullItem.message, fullItem.scheduled_at || null, fullItem.cron_expression || null, fullItem.context_note || null, fullItem.status, fullItem.created_at);
        return fullItem;
    }
    getSchedules(statusFilter) {
        let query = 'SELECT * FROM schedules';
        const params = [];
        if (statusFilter) {
            query += ' WHERE status = ?';
            params.push(statusFilter);
        }
        query += ' ORDER BY created_at DESC';
        return this.db.prepare(query).all(...params);
    }
    getPendingDueSchedules(nowIso) {
        const stmt = this.db.prepare(`
      SELECT * FROM schedules 
      WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
    `);
        return stmt.all(nowIso);
    }
    updateScheduleStatus(id, status, error) {
        const stmt = this.db.prepare(`
      UPDATE schedules 
      SET status = ?, last_executed_at = ?, error = ?
      WHERE id = ?
    `);
        stmt.run(status, new Date().toISOString(), error || null, id);
    }
    deleteSchedule(id) {
        const stmt = this.db.prepare('DELETE FROM schedules WHERE id = ?');
        const result = stmt.run(id);
        return result.changes > 0;
    }
    // --- Campaign Contexts for Follow-ups ---
    setCampaignContext(recipientJid, initialMessage, contextNote, scheduleId) {
        // Deactivate previous active campaigns for this jid
        this.db.prepare('UPDATE campaign_contexts SET active = 0 WHERE recipient_jid = ?').run(recipientJid);
        const id = 'camp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
      INSERT INTO campaign_contexts (
        id, recipient_jid, initial_message, context_note, scheduled_id, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
        stmt.run(id, recipientJid, initialMessage, contextNote, scheduleId || null, now, now);
    }
    getActiveCampaignContext(recipientJid) {
        const stmt = this.db.prepare(`
      SELECT * FROM campaign_contexts 
      WHERE recipient_jid = ? AND active = 1 
      ORDER BY created_at DESC LIMIT 1
    `);
        const row = stmt.get(recipientJid);
        return row ? { ...row, active: Boolean(row.active) } : null;
    }
    deactivateCampaignContext(recipientJid) {
        this.db.prepare('UPDATE campaign_contexts SET active = 0 WHERE recipient_jid = ?').run(recipientJid);
    }
    // --- Logging ---
    log(level, message, details) {
        const timestamp = new Date().toISOString();
        const detailsStr = details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null;
        try {
            this.db.prepare(`
        INSERT INTO logs (timestamp, level, message, details) VALUES (?, ?, ?, ?)
      `).run(timestamp, level, message, detailsStr);
        }
        catch (e) {
            console.error('Failed to write log to DB:', e);
        }
    }
    getLogs(limit = 100) {
        return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
    }
    clearLogs() {
        this.db.prepare('DELETE FROM logs').run();
    }
}
exports.db = new StorageDB();
