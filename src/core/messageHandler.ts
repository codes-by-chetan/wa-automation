import { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { db } from '../storage/db';
import { ruleEngine, MessageContext } from '../services/ruleEngine';
import { llmService } from '../services/llm';
import { playAlertSound, triggerEmergencyAlert } from '../services/alert';
import { waManager } from './whatsapp';

export class MessageHandler {
  /**
   * Extract plain text content from various WhatsApp message types
   */
  public extractText(msg: WAMessage): string {
    const message = msg.message;
    if (!message) return '';

    return (
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      message.documentMessage?.caption ||
      message.buttonsResponseMessage?.selectedButtonId ||
      message.templateButtonReplyMessage?.selectedId ||
      message.listResponseMessage?.singleSelectReply?.selectedRowId ||
      ''
    ).trim();
  }

  /**
   * Process incoming messages upsert event
   */
  public async handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
    const jid = msg.key.remoteJid;
    if (!jid) return;

    const fromMe = Boolean(msg.key.fromMe);
    const isGroup = jid.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || jid) : jid;
    const senderName = msg.pushName || undefined;
    const content = this.extractText(msg);
    const timestamp = typeof msg.messageTimestamp === 'number' 
      ? msg.messageTimestamp 
      : Math.floor(Date.now() / 1000);
    const messageId = msg.key.id || `msg_${Date.now()}`;

    // Always store incoming/outgoing message in local history
    if (content) {
      db.saveMessage({
        id: messageId,
        jid,
        sender,
        sender_name: senderName,
        content,
        from_me: fromMe,
        is_group: isGroup,
        timestamp,
        is_bot_reply: false,
      });
    }

    // Evaluate rules
    const context: MessageContext = {
      jid,
      sender,
      fromMe,
      isGroup,
      content,
      timestamp,
    };

    const evaluation = ruleEngine.evaluate(context);
    if (!evaluation.shouldReply) {
      // Don't clutter logs with broadcast or self messages
      if (!fromMe && !jid.includes('@broadcast') && content) {
        db.log('INFO', `Message skipped from ${jid}: ${evaluation.reason}`);
      }
      return;
    }

    const settings = db.getSettings();

    try {
      db.log('INFO', `Triggering AI auto-reply for ${jid}`, {
        sender: senderName || sender,
        message: content,
      });

      // Simulate human typing presence
      if (settings.typing_simulation) {
        await sock.sendPresenceUpdate('composing', jid);
        // Small organic delay between 1.5s to 3s
        await new Promise((resolve) => setTimeout(resolve, 1500 + Math.random() * 1500));
      }

      // Check if there is an active campaign context (e.g. from a scheduled outreach)
      const campaignContext = db.getActiveCampaignContext(jid);

      // Fetch recent message history (excluding the current one since it's passed directly)
      const history = db.getRecentMessages(jid, settings.history_limit).filter((m) => m.id !== messageId);

      // Generate response using OpenAI-compatible LLM
      const ownerName = waManager.getOwnerName();
      const replyRaw = await llmService.generateReply({
        jid,
        senderName,
        ownerName,
        isGroup,
        incomingText: content,
        history,
        campaignContext,
      });

      if (!replyRaw || replyRaw.trim().length === 0) {
        db.log('WARN', `LLM generated an empty response for ${jid}`);
        if (settings.typing_simulation) {
          await sock.sendPresenceUpdate('paused', jid);
        }
        return;
      }

      // Check if notification or wake-up was requested by the user or triggered by LLM
      const hasNotifyTag = replyRaw.includes('[NOTIFY_OWNER]');
      const lowerIncoming = content.toLowerCase();
      const directNotifyRequest = 
        lowerIncoming.includes('wake') ||
        lowerIncoming.includes('wake up') ||
        lowerIncoming.includes('wake him') ||
        lowerIncoming.includes('sleeping') ||
        lowerIncoming.includes('notify') || 
        lowerIncoming.includes('let him know') || 
        lowerIncoming.includes('tell him') || 
        lowerIncoming.includes('call him') || 
        lowerIncoming.includes('urgent') ||
        lowerIncoming.includes('emergency');

      if (hasNotifyTag || directNotifyRequest) {
        await triggerEmergencyAlert({
          ownerName,
          senderName: senderName || jid.split('@')[0],
          senderJid: jid,
          incomingText: content,
          sock,
        });
      }

      // Strip [NOTIFY_OWNER] tag before sending to WhatsApp
      const replyText = replyRaw.replace(/\[NOTIFY_OWNER\]/gi, '').trim();

      // Send the reply message
      // For groups, quote the sender's message for clear conversational context
      const sentMsg = await sock.sendMessage(jid, { text: replyText }, { quoted: msg });

      // Save the bot's reply in memory
      if (sentMsg?.key?.id) {
        db.saveMessage({
          id: sentMsg.key.id,
          jid,
          sender: sock.user?.id || 'bot',
          sender_name: 'AI Bot',
          content: replyText,
          from_me: true,
          is_group: isGroup,
          timestamp: Math.floor(Date.now() / 1000),
          is_bot_reply: true,
        });
      }

      db.log('REPLY', `AI replied to ${senderName || jid}`, {
        incoming: content,
        reply: replyText,
        campaignAttached: Boolean(campaignContext),
      });

      if (settings.typing_simulation) {
        await sock.sendPresenceUpdate('paused', jid);
      }
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      console.error(`[MessageHandler] Error generating/sending reply for ${jid}:`, errorMsg);
      db.log('ERROR', `Failed to reply to ${jid}`, { error: errorMsg });

      if (settings.typing_simulation) {
        try {
          await sock.sendPresenceUpdate('paused', jid);
        } catch {}
      }
    }
  }
}

export const messageHandler = new MessageHandler();
