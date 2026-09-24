import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';

export interface AppSettings {
  llm_base_url: string;
  llm_api_key: string;
  llm_model: string;
  system_prompt: string;
  target_mode: 'all' | 'contacts_only' | 'groups_only' | 'whitelist_only' | 'disabled';
  whitelist: string[]; // phone numbers or JIDs
  blacklist: string[]; // phone numbers or JIDs
  cooldown_seconds: number;
  typing_simulation: boolean;
  history_limit: number;
  scheduled_reply_mode: 'reply_with_context' | 'default';
  emergency_number: string;
  emergency_call_webhook: string;
  callmebot_api_key: string;
}

export interface ChatMessage {
  id: string;
  jid: string;
  sender: string;
  sender_name?: string;
  content: string;
  from_me: boolean;
  is_group: boolean;
  timestamp: number;
  is_bot_reply: boolean;
}

export interface ScheduleItem {
  id: string;
  recipient: string; // phone number or JID
  message: string;
  scheduled_at?: string | null; // ISO string for one-time
  cron_expression?: string | null; // Cron for recurring
  context_note?: string | null; // Note for AI when recipient replies
  status: 'pending' | 'completed' | 'active_cron' | 'cancelled' | 'failed';
  created_at: string;
  last_executed_at?: string | null;
  error?: string | null;
}

export interface CampaignContext {
  id: string;
  recipient_jid: string;
  initial_message: string;
  context_note: string;
  scheduled_id?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SystemLog {
  id: number;
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR' | 'REPLY' | 'ALERT';
  message: string;
  details?: string | null;
}

class StorageDB {
  private db: Database.Database;

  constructor() {
    if (!fs.existsSync(CONFIG.DATA_DIR)) {
      fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
    }
    this.db = new Database(CONFIG.DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables(): void {
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

  private initDefaultSettings(): void {
    const defaults: AppSettings = {
      llm_base_url: CONFIG.DEFAULT_LLM_BASE_URL,
      llm_api_key: CONFIG.DEFAULT_LLM_API_KEY,
      llm_model: CONFIG.DEFAULT_LLM_MODEL,
      system_prompt: CONFIG.DEFAULT_SYSTEM_PROMPT,
      target_mode: 'contacts_only',
      whitelist: [],
      blacklist: [],
      cooldown_seconds: 5,
      typing_simulation: true,
      history_limit: 10,
      scheduled_reply_mode: 'reply_with_context',
      emergency_number: CONFIG.EMERGENCY_NUMBER,
      emergency_call_webhook: CONFIG.EMERGENCY_CALL_WEBHOOK_URL,
      callmebot_api_key: CONFIG.CALLMEBOT_API_KEY,
    };

    const selectStmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const insertStmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    const updateStmt = this.db.prepare('UPDATE settings SET value = ? WHERE key = ?');

    for (const [key, val] of Object.entries(defaults)) {
      const existing = selectStmt.get(key);
      if (!existing) {
        insertStmt.run(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
      }
    }

    // Automatically sync environment variables from .env if defined
    if (process.env.LLM_BASE_URL) {
      updateStmt.run(process.env.LLM_BASE_URL, 'llm_base_url');
    }
    if (process.env.LLM_API_KEY) {
      updateStmt.run(process.env.LLM_API_KEY, 'llm_api_key');
    }
    if (process.env.LLM_MODEL) {
      updateStmt.run(process.env.LLM_MODEL, 'llm_model');
    }
    if (process.env.SYSTEM_PROMPT) {
      updateStmt.run(process.env.SYSTEM_PROMPT, 'system_prompt');
    }
    if (process.env.EMERGENCY_NUMBER) {
      updateStmt.run(process.env.EMERGENCY_NUMBER, 'emergency_number');
    }
    if (process.env.EMERGENCY_CALL_WEBHOOK_URL) {
      updateStmt.run(process.env.EMERGENCY_CALL_WEBHOOK_URL, 'emergency_call_webhook');
    }
    if (process.env.CALLMEBOT_API_KEY) {
      updateStmt.run(process.env.CALLMEBOT_API_KEY, 'callmebot_api_key');
    }
  }

  // --- Settings ---
  public getSettings(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const result: Record<string, any> = {};

    for (const row of rows) {
      if (['whitelist', 'blacklist'].includes(row.key)) {
        try {
          result[row.key] = JSON.parse(row.value);
        } catch {
          result[row.key] = [];
        }
      } else if (['cooldown_seconds', 'history_limit'].includes(row.key)) {
        result[row.key] = parseInt(row.value, 10) || 5;
      } else if (['typing_simulation'].includes(row.key)) {
        result[row.key] = row.value === 'true' || row.value === '1';
      } else {
        result[row.key] = row.value;
      }
    }

    return result as AppSettings;
  }

  public updateSettings(updates: Partial<AppSettings>): AppSettings {
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    const updateTx = this.db.transaction((items: [string, any][]) => {
      for (const [key, val] of items) {
        const strVal = typeof val === 'object' ? JSON.stringify(val) : String(val);
        stmt.run(key, strVal);
      }
    });

    updateTx(Object.entries(updates));
    return this.getSettings();
  }

  // --- Messages & Memory ---
  public saveMessage(msg: ChatMessage): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, jid, sender, sender_name, content, from_me, is_group, timestamp, is_bot_reply
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      msg.id,
      msg.jid,
      msg.sender,
      msg.sender_name || null,
      msg.content,
      msg.from_me ? 1 : 0,
      msg.is_group ? 1 : 0,
      msg.timestamp,
      msg.is_bot_reply ? 1 : 0
    );
  }

  public getRecentMessages(jid: string, limit = 10): ChatMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages 
      WHERE jid = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `);

    const rows = stmt.all(jid, limit) as any[];
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

  public getLastBotReplyTime(jid: string): number | null {
    const stmt = this.db.prepare(`
      SELECT timestamp FROM messages 
      WHERE jid = ? AND is_bot_reply = 1 
      ORDER BY timestamp DESC LIMIT 1
    `);
    const row = stmt.get(jid) as { timestamp: number } | undefined;
    return row ? row.timestamp : null;
  }

  public getRecentChats(limit = 20): { jid: string; sender_name?: string; last_content: string; timestamp: number; is_group: boolean }[] {
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
    return stmt.all(limit) as any[];
  }

  // --- Schedules ---
  public createSchedule(item: Omit<ScheduleItem, 'status' | 'created_at'> & { status?: ScheduleItem['status'] }): ScheduleItem {
    const fullItem: ScheduleItem = {
      ...item,
      status: item.status || (item.cron_expression ? 'active_cron' : 'pending'),
      created_at: new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO schedules (
        id, recipient, message, scheduled_at, cron_expression, context_note, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      fullItem.id,
      fullItem.recipient,
      fullItem.message,
      fullItem.scheduled_at || null,
      fullItem.cron_expression || null,
      fullItem.context_note || null,
      fullItem.status,
      fullItem.created_at
    );

    return fullItem;
  }

  public getSchedules(statusFilter?: string): ScheduleItem[] {
    let query = 'SELECT * FROM schedules';
    const params: any[] = [];
    if (statusFilter) {
      query += ' WHERE status = ?';
      params.push(statusFilter);
    }
    query += ' ORDER BY created_at DESC';
    return this.db.prepare(query).all(...params) as ScheduleItem[];
  }

  public getPendingDueSchedules(nowIso: string): ScheduleItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM schedules 
      WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
    `);
    return stmt.all(nowIso) as ScheduleItem[];
  }

  public updateScheduleStatus(id: string, status: ScheduleItem['status'], error?: string | null): void {
    const stmt = this.db.prepare(`
      UPDATE schedules 
      SET status = ?, last_executed_at = ?, error = ?
      WHERE id = ?
    `);
    stmt.run(status, new Date().toISOString(), error || null, id);
  }

  public deleteSchedule(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM schedules WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // --- Campaign Contexts for Follow-ups ---
  public setCampaignContext(recipientJid: string, initialMessage: string, contextNote: string, scheduleId?: string): void {
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

  public getActiveCampaignContext(recipientJid: string): CampaignContext | null {
    const stmt = this.db.prepare(`
      SELECT * FROM campaign_contexts 
      WHERE recipient_jid = ? AND active = 1 
      ORDER BY created_at DESC LIMIT 1
    `);
    const row = stmt.get(recipientJid) as CampaignContext | undefined;
    return row ? { ...row, active: Boolean(row.active) } : null;
  }

  public deactivateCampaignContext(recipientJid: string): void {
    this.db.prepare('UPDATE campaign_contexts SET active = 0 WHERE recipient_jid = ?').run(recipientJid);
  }

  // --- Logging ---
  public log(level: SystemLog['level'], message: string, details?: any): void {
    const timestamp = new Date().toISOString();
    const detailsStr = details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null;
    
    try {
      this.db.prepare(`
        INSERT INTO logs (timestamp, level, message, details) VALUES (?, ?, ?, ?)
      `).run(timestamp, level, message, detailsStr);
    } catch (e) {
      console.error('Failed to write log to DB:', e);
    }
  }

  public getLogs(limit = 100): SystemLog[] {
    return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit) as SystemLog[];
  }

  public clearLogs(): void {
    this.db.prepare('DELETE FROM logs').run();
  }
}

export const db = new StorageDB();
