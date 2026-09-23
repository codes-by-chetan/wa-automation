"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ruleEngine = exports.RuleEngine = void 0;
const db_1 = require("../storage/db");
class RuleEngine {
    /**
     * Normalize a phone number or JID for matching.
     * Strips '+' and spaces, or converts phone to WhatsApp standard format.
     */
    normalizeTarget(target) {
        const trimmed = target.trim().toLowerCase();
        if (trimmed.includes('@')) {
            return trimmed;
        }
        // Remove non-digit chars
        const digitsOnly = trimmed.replace(/\D/g, '');
        return `${digitsOnly}@s.whatsapp.net`;
    }
    /**
     * Check if a JID matches an array of configured targets (phones or JIDs).
     */
    matchesTargetList(jid, sender, list) {
        if (!list || list.length === 0)
            return false;
        const normalizedJid = this.normalizeTarget(jid);
        const normalizedSender = this.normalizeTarget(sender);
        return list.some((item) => {
            const normalizedItem = this.normalizeTarget(item);
            return (normalizedItem === normalizedJid ||
                normalizedItem === normalizedSender ||
                // Check if plain phone digits match
                jid.startsWith(item.replace(/\D/g, '') + '@') ||
                sender.startsWith(item.replace(/\D/g, '') + '@'));
        });
    }
    /**
     * Evaluate whether the bot should auto-reply to an incoming message.
     */
    evaluate(msg) {
        const settings = db_1.db.getSettings();
        // 1. Ignore messages sent by self
        if (msg.fromMe) {
            return { shouldReply: false, reason: 'Ignored: Message sent by self' };
        }
        // 2. Ignore WhatsApp Status broadcasts
        if (msg.jid.includes('@broadcast') || msg.jid === 'status@broadcast') {
            return { shouldReply: false, reason: 'Ignored: Broadcast or status update' };
        }
        // 3. Ignore empty or non-text messages
        if (!msg.content || msg.content.trim().length === 0) {
            return { shouldReply: false, reason: 'Ignored: Empty message' };
        }
        // 4. Check if auto-reply is completely disabled
        if (settings.target_mode === 'disabled') {
            return { shouldReply: false, reason: 'Disabled: Target mode is disabled' };
        }
        // 5. Check Blacklist
        if (this.matchesTargetList(msg.jid, msg.sender, settings.blacklist)) {
            return { shouldReply: false, reason: 'Ignored: Matched blacklist' };
        }
        // 6. Check Target Mode
        switch (settings.target_mode) {
            case 'contacts_only':
                if (msg.isGroup) {
                    return { shouldReply: false, reason: 'Ignored: Groups disabled in contacts_only mode' };
                }
                break;
            case 'groups_only':
                if (!msg.isGroup) {
                    return { shouldReply: false, reason: 'Ignored: Direct chats disabled in groups_only mode' };
                }
                break;
            case 'whitelist_only':
                if (!this.matchesTargetList(msg.jid, msg.sender, settings.whitelist)) {
                    return { shouldReply: false, reason: 'Ignored: Not in whitelist' };
                }
                break;
            case 'all':
            default:
                // Allowed for all non-blacklisted
                break;
        }
        // 7. Check Cooldown to avoid rapid spam
        if (settings.cooldown_seconds > 0) {
            const lastReplyTime = db_1.db.getLastBotReplyTime(msg.jid);
            if (lastReplyTime) {
                const diffSeconds = (Date.now() / 1000) - lastReplyTime;
                if (diffSeconds < settings.cooldown_seconds) {
                    return {
                        shouldReply: false,
                        reason: `Ignored: Cooldown active (${Math.round(diffSeconds)}s / ${settings.cooldown_seconds}s)`,
                    };
                }
            }
        }
        return { shouldReply: true, reason: 'Passed all rule filters' };
    }
}
exports.RuleEngine = RuleEngine;
exports.ruleEngine = new RuleEngine();
