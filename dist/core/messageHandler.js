"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.messageHandler = exports.MessageHandler = void 0;
const db_1 = require("../storage/db");
const ruleEngine_1 = require("../services/ruleEngine");
const llm_1 = require("../services/llm");
class MessageHandler {
    /**
     * Extract plain text content from various WhatsApp message types
     */
    extractText(msg) {
        const message = msg.message;
        if (!message)
            return '';
        return (message.conversation ||
            message.extendedTextMessage?.text ||
            message.imageMessage?.caption ||
            message.videoMessage?.caption ||
            message.documentMessage?.caption ||
            message.buttonsResponseMessage?.selectedButtonId ||
            message.templateButtonReplyMessage?.selectedId ||
            message.listResponseMessage?.singleSelectReply?.selectedRowId ||
            '').trim();
    }
    /**
     * Process incoming messages upsert event
     */
    async handleMessage(sock, msg) {
        const jid = msg.key.remoteJid;
        if (!jid)
            return;
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
            db_1.db.saveMessage({
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
        const context = {
            jid,
            sender,
            fromMe,
            isGroup,
            content,
            timestamp,
        };
        const evaluation = ruleEngine_1.ruleEngine.evaluate(context);
        if (!evaluation.shouldReply) {
            // Don't clutter logs with broadcast or self messages
            if (!fromMe && !jid.includes('@broadcast') && content) {
                db_1.db.log('INFO', `Message skipped from ${jid}: ${evaluation.reason}`);
            }
            return;
        }
        const settings = db_1.db.getSettings();
        try {
            db_1.db.log('INFO', `Triggering AI auto-reply for ${jid}`, {
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
            const campaignContext = db_1.db.getActiveCampaignContext(jid);
            // Fetch recent message history (excluding the current one since it's passed directly)
            const history = db_1.db.getRecentMessages(jid, settings.history_limit).filter((m) => m.id !== messageId);
            // Generate response using OpenAI-compatible LLM
            const replyText = await llm_1.llmService.generateReply({
                jid,
                senderName,
                isGroup,
                incomingText: content,
                history,
                campaignContext,
            });
            if (!replyText || replyText.trim().length === 0) {
                db_1.db.log('WARN', `LLM generated an empty response for ${jid}`);
                if (settings.typing_simulation) {
                    await sock.sendPresenceUpdate('paused', jid);
                }
                return;
            }
            // Send the reply message
            // For groups, quote the sender's message for clear conversational context
            const sentMsg = await sock.sendMessage(jid, { text: replyText }, { quoted: msg });
            // Save the bot's reply in memory
            if (sentMsg?.key?.id) {
                db_1.db.saveMessage({
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
            db_1.db.log('REPLY', `AI replied to ${senderName || jid}`, {
                incoming: content,
                reply: replyText,
                campaignAttached: Boolean(campaignContext),
            });
            if (settings.typing_simulation) {
                await sock.sendPresenceUpdate('paused', jid);
            }
        }
        catch (err) {
            const errorMsg = err?.message || String(err);
            console.error(`[MessageHandler] Error generating/sending reply for ${jid}:`, errorMsg);
            db_1.db.log('ERROR', `Failed to reply to ${jid}`, { error: errorMsg });
            if (settings.typing_simulation) {
                try {
                    await sock.sendPresenceUpdate('paused', jid);
                }
                catch { }
            }
        }
    }
}
exports.MessageHandler = MessageHandler;
exports.messageHandler = new MessageHandler();
