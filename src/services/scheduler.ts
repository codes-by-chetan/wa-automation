import cron, { ScheduledTask } from 'node-cron';
import { db, ScheduleItem } from '../storage/db';

export type SendMessageFunction = (recipientJid: string, text: string) => Promise<boolean>;

export class MessageScheduler {
  private sendMessageFn: SendMessageFunction | null = null;
  private cronTasks: Map<string, ScheduledTask> = new Map();
  private checkInterval: NodeJS.Timeout | null = null;

  public init(sendMessageFn: SendMessageFunction): void {
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

  public stop(): void {
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
  public reloadCronSchedules(): void {
    // Stop all current cron tasks
    for (const [, task] of this.cronTasks.entries()) {
      task.stop();
    }
    this.cronTasks.clear();

    const activeCrons = db.getSchedules('active_cron');
    for (const item of activeCrons) {
      if (item.cron_expression && cron.validate(item.cron_expression)) {
        try {
          const task = cron.schedule(item.cron_expression, async () => {
            await this.dispatchScheduledMessage(item);
          });
          this.cronTasks.set(item.id, task);
        } catch (e: any) {
          console.error(`[Scheduler] Invalid cron for ${item.id}:`, e);
        }
      }
    }
  }

  /**
   * Check and dispatch any one-off schedules that are due
   */
  public async processDueSchedules(): Promise<void> {
    if (!this.sendMessageFn) return;

    const nowIso = new Date().toISOString();
    const dueItems = db.getPendingDueSchedules(nowIso);

    for (const item of dueItems) {
      await this.dispatchScheduledMessage(item);
    }
  }

  /**
   * Format phone number or JID to standard WhatsApp JID
   */
  public formatJid(recipient: string): string {
    const trimmed = recipient.trim();
    if (trimmed.includes('@')) return trimmed;
    const digits = trimmed.replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  /**
   * Dispatch a scheduled message and register follow-up reply context
   */
  public async dispatchScheduledMessage(item: ScheduleItem): Promise<boolean> {
    if (!this.sendMessageFn) {
      db.log('WARN', `Cannot send schedule ${item.id}: WhatsApp client not ready`);
      return false;
    }

    const jid = this.formatJid(item.recipient);

    try {
      db.log('INFO', `Dispatching scheduled message to ${jid}`, { scheduleId: item.id, message: item.message });
      const success = await this.sendMessageFn(jid, item.message);

      if (success) {
        if (!item.cron_expression) {
          db.updateScheduleStatus(item.id, 'completed');
        } else {
          db.updateScheduleStatus(item.id, 'active_cron');
        }

        // If a context note was provided, activate campaign context so replies get special handling
        if (item.context_note && item.context_note.trim().length > 0) {
          db.setCampaignContext(jid, item.message, item.context_note.trim(), item.id);
          db.log('INFO', `Activated follow-up reply context for ${jid}`, { contextNote: item.context_note });
        }

        return true;
      } else {
        db.updateScheduleStatus(item.id, item.cron_expression ? 'active_cron' : 'failed', 'Socket send returned false');
        return false;
      }
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      db.log('ERROR', `Failed to dispatch schedule ${item.id}`, { error: errorMsg });
      db.updateScheduleStatus(item.id, item.cron_expression ? 'active_cron' : 'failed', errorMsg);
      return false;
    }
  }

  /**
   * Add a new schedule
   */
  public addSchedule(options: {
    recipient: string;
    message: string;
    scheduledAt?: string | null;
    cronExpression?: string | null;
    contextNote?: string | null;
  }): ScheduleItem {
    const id = 'sch_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const item = db.createSchedule({
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
  public deleteSchedule(id: string): boolean {
    const task = this.cronTasks.get(id);
    if (task) {
      task.stop();
      this.cronTasks.delete(id);
    }
    return db.deleteSchedule(id);
  }
}

export const messageScheduler = new MessageScheduler();
