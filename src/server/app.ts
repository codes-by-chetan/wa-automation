import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { db } from '../storage/db';
import { waManager } from '../core/whatsapp';
import { llmService } from '../services/llm';
import { messageScheduler } from '../services/scheduler';
import { triggerEmergencyAlert } from '../services/alert';

export function createServer(): express.Express {
  const app = express();

  const publicDir = fs.existsSync(path.resolve(__dirname, 'public'))
    ? path.resolve(__dirname, 'public')
    : path.resolve(process.cwd(), 'src', 'server', 'public');

  app.use(cors());
  app.use(express.json());
  app.use(express.static(publicDir));

  // 1. WhatsApp Connection Status
  app.get('/api/status', (_req: Request, res: Response) => {
    res.json(waManager.getStatus());
  });

  app.post('/api/reconnect', async (req: Request, res: Response) => {
    try {
      const forceNew = req.body?.forceNew === true || waManager.getStatus().status !== 'connected';
      await waManager.restart(forceNew);
      res.json({ success: true, message: 'Reconnecting WhatsApp...' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/logout', async (_req: Request, res: Response) => {
    try {
      await waManager.logout();
      res.json({ success: true, message: 'Logged out successfully' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 2. Settings Endpoints
  app.get('/api/settings', (_req: Request, res: Response) => {
    const settings = db.getSettings();
    res.json(settings);
  });

  app.post('/api/settings', (req: Request, res: Response) => {
    try {
      const updated = db.updateSettings(req.body);
      db.log('INFO', 'Settings updated via Web Dashboard');
      res.json({ success: true, settings: updated });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // 2.1 Test Emergency Alert Endpoint
  app.post('/api/test-emergency', async (req: Request, res: Response) => {
    try {
      const settings = db.getSettings();
      const emergencyNumber = (req.body?.emergencyNumber || settings.emergency_number || '').trim();
      const callmebotApiKey = (req.body?.callmebotApiKey || settings.callmebot_api_key || '').trim();
      const ownerName = waManager.getOwnerName();

      await triggerEmergencyAlert({
        ownerName,
        senderName: 'Test Alert (Dashboard)',
        senderJid: 'dashboard-test@s.whatsapp.net',
        incomingText: 'Wake up! This is a test emergency alert from the Web Dashboard.',
        sock: waManager.getSocket(),
        emergencyNumberOverride: emergencyNumber,
        callmebotApiKeyOverride: callmebotApiKey,
      });

      res.json({
        success: true,
        message: 'Emergency ringtone played, call triggered & WhatsApp SOS sent',
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. Test LLM Endpoint
  app.post('/api/test-llm', async (req: Request, res: Response) => {
    const { baseUrl, apiKey, model, systemPrompt, sampleMessage } = req.body;
    const result = await llmService.testCompletion(baseUrl, apiKey, model, systemPrompt, sampleMessage);
    res.json(result);
  });

  // 4. Schedules Endpoints
  app.get('/api/schedules', (_req: Request, res: Response) => {
    const schedules = db.getSchedules();
    res.json(schedules);
  });

  app.post('/api/schedules', (req: Request, res: Response) => {
    const { recipient, message, scheduledAt, cronExpression, contextNote } = req.body;

    if (!recipient || !message) {
      return res.status(400).json({ success: false, error: 'Recipient and message are required' });
    }

    try {
      const schedule = messageScheduler.addSchedule({
        recipient,
        message,
        scheduledAt: scheduledAt || null,
        cronExpression: cronExpression || null,
        contextNote: contextNote || null,
      });

      db.log('INFO', `Created new schedule for ${recipient}`, { scheduleId: schedule.id });
      res.json({ success: true, schedule });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/schedules/:id', (req: Request, res: Response) => {
    const scheduleId = String(req.params.id);
    const success = messageScheduler.deleteSchedule(scheduleId);
    if (success) {
      res.json({ success: true, message: 'Schedule removed' });
    } else {
      res.status(404).json({ success: false, error: 'Schedule not found' });
    }
  });

  app.post('/api/schedules/:id/run', async (req: Request, res: Response) => {
    const schedules = db.getSchedules();
    const scheduleId = String(req.params.id);
    const item = schedules.find((s) => s.id === scheduleId);

    if (!item) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    const success = await messageScheduler.dispatchScheduledMessage(item);
    res.json({ success, message: success ? 'Dispatched' : 'Failed to dispatch' });
  });

  // 5. Send one-off immediate message
  app.post('/api/send', async (req: Request, res: Response) => {
    const { recipient, message, contextNote } = req.body;

    if (!recipient || !message) {
      return res.status(400).json({ success: false, error: 'Recipient and message are required' });
    }

    try {
      await waManager.sendMessage(recipient, message);

      if (contextNote && contextNote.trim().length > 0) {
        const jid = messageScheduler.formatJid(recipient);
        db.setCampaignContext(jid, message, contextNote.trim());
      }

      res.json({ success: true, message: 'Message sent successfully' });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 6. Recent chats & messages
  app.get('/api/chats', (_req: Request, res: Response) => {
    const chats = db.getRecentChats(50);
    res.json(chats);
  });

  app.get('/api/chats/:jid/messages', (req: Request, res: Response) => {
    const jid = String(req.params.jid);
    const messages = db.getRecentMessages(jid, 30);
    const campaignContext = db.getActiveCampaignContext(jid);
    res.json({ messages, campaignContext });
  });

  // 7. System Logs
  app.get('/api/logs', (_req: Request, res: Response) => {
    const logs = db.getLogs(60);
    res.json(logs);
  });

  app.post('/api/logs/clear', (_req: Request, res: Response) => {
    db.clearLogs();
    res.json({ success: true });
  });

  // Fallback to index.html for SPA
  app.use((_req: Request, res: Response) => {
    res.sendFile(path.resolve(publicDir, 'index.html'));
  });

  return app;
}
