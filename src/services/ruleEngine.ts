import fs from 'fs';
import path from 'path';
import { CONFIG } from '../config';
import { db } from '../storage/db';

export interface MessageContext {
  jid: string;           // Chat JID (e.g. 1234567890@s.whatsapp.net or 120363@g.us or 144804822409232@lid)
  sender: string;        // Participant JID in group, or same as jid in direct
  fromMe: boolean;       // Message sent by the bot's own WhatsApp account
  isGroup: boolean;      // True if group chat
  content: string;       // Text content
  timestamp: number;     // Unix timestamp (seconds)
}

export interface RuleEvaluationResult {
  shouldReply: boolean;
  reason: string;
}

export class RuleEngine {
  /**
   * Helper to look up mapped phone number from an LID (or vice versa) in auth_baileys.
   */
  private getLidMapping(id: string): string | null {
    const cleanDigits = id.replace(/\D/g, '');
    if (!cleanDigits) return null;

    try {
      if (fs.existsSync(CONFIG.AUTH_DIR)) {
        // 1. If cleanDigits is an LID, check if reverse mapping exists (gives phone number)
        const reverseFile = path.join(CONFIG.AUTH_DIR, `lid-mapping-${cleanDigits}_reverse.json`);
        if (fs.existsSync(reverseFile)) {
          const content = JSON.parse(fs.readFileSync(reverseFile, 'utf8'));
          if (typeof content === 'string') return content.replace(/\D/g, '');
        }

        // 2. If cleanDigits is a phone number, check if forward mapping exists (gives LID)
        const forwardFile = path.join(CONFIG.AUTH_DIR, `lid-mapping-${cleanDigits}.json`);
        if (fs.existsSync(forwardFile)) {
          const content = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
          if (typeof content === 'string') return content.replace(/\D/g, '');
        }

        // 3. Suffix search if cleanDigits is at least 7 digits (e.g. phone entered without country code)
        if (cleanDigits.length >= 7) {
          const files = fs.readdirSync(CONFIG.AUTH_DIR);
          for (const file of files) {
            if (file.startsWith('lid-mapping-') && file.endsWith('.json')) {
              if (file.includes(cleanDigits)) {
                const fullPath = path.join(CONFIG.AUTH_DIR, file);
                const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                if (typeof content === 'string') return content.replace(/\D/g, '');
              }
            }
          }
        }
      }
    } catch {}

    return null;
  }

  /**
   * Collect all normalized forms/aliases of a WhatsApp JID / sender (phone numbers, LIDs, last 10 digits).
   */
  private getCandidateIdentifiers(jid: string, sender: string): Set<string> {
    const candidates = new Set<string>();

    const addJidForms = (raw: string) => {
      if (!raw) return;
      const lower = raw.trim().toLowerCase();
      candidates.add(lower);

      const digits = lower.replace(/\D/g, '');
      if (digits) {
        candidates.add(digits);
        if (digits.length >= 10) {
          candidates.add(digits.slice(-10));
        }

        // Check if there is an LID or reverse phone mapping
        const mapped = this.getLidMapping(digits);
        if (mapped) {
          candidates.add(mapped);
          candidates.add(`${mapped}@s.whatsapp.net`);
          candidates.add(`${mapped}@lid`);
          if (mapped.length >= 10) {
            candidates.add(mapped.slice(-10));
          }
        }
      }
    };

    addJidForms(jid);
    addJidForms(sender);

    return candidates;
  }

  /**
   * Normalize a phone number or JID for matching.
   */
  public normalizeTarget(target: string): string {
    const trimmed = target.trim().toLowerCase();
    if (trimmed.includes('@')) {
      return trimmed;
    }
    const digitsOnly = trimmed.replace(/\D/g, '');
    return `${digitsOnly}@s.whatsapp.net`;
  }

  /**
   * Check if an incoming message matches an array of configured targets (phones, LIDs, or JIDs).
   */
  public matchesTargetList(jid: string, sender: string, list: string[]): boolean {
    if (!list || list.length === 0) return false;

    const candidates = this.getCandidateIdentifiers(jid, sender);

    return list.some((item) => {
      if (!item) return false;
      const itemClean = item.trim().toLowerCase();
      const itemDigits = item.replace(/\D/g, '');

      // 1. Exact string match (e.g. 144804822409232@lid, 120363@g.us)
      if (candidates.has(itemClean)) return true;

      // 2. Full digit match (e.g. 919764560354)
      if (itemDigits && candidates.has(itemDigits)) return true;

      // 3. National 10-digit suffix match (e.g. entered without country code: 9764560354)
      if (itemDigits && itemDigits.length >= 10 && candidates.has(itemDigits.slice(-10))) {
        return true;
      }

      // 4. Check if item has a known LID mapping
      if (itemDigits) {
        const itemMapped = this.getLidMapping(itemDigits);
        if (itemMapped) {
          if (candidates.has(itemMapped)) return true;
          if (candidates.has(`${itemMapped}@lid`)) return true;
          if (candidates.has(`${itemMapped}@s.whatsapp.net`)) return true;
        }
      }

      // 5. Standard JID match
      if (itemDigits && (candidates.has(`${itemDigits}@s.whatsapp.net`) || candidates.has(`${itemDigits}@lid`))) {
        return true;
      }

      return false;
    });
  }

  /**
   * Evaluate whether the bot should auto-reply to an incoming message.
   */
  public evaluate(msg: MessageContext): RuleEvaluationResult {
    const settings = db.getSettings();

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
      const lastReplyTime = db.getLastBotReplyTime(msg.jid);
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

export const ruleEngine = new RuleEngine();
