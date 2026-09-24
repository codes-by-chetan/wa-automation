import OpenAI from 'openai';
import { db, CampaignContext, ChatMessage } from '../storage/db';

export interface LLMGenerateOptions {
  jid: string;
  senderName?: string;
  ownerName?: string;
  isGroup: boolean;
  incomingText: string;
  history?: ChatMessage[];
  campaignContext?: CampaignContext | null;
}

export class LLMService {
  private client: OpenAI | null = null;
  private currentBaseUrl: string = '';
  private currentApiKey: string = '';

  private normalizeBaseUrl(url?: string): string {
    let clean = (url || '').trim();
    if (!clean) return 'https://api.openai.com/v1';
    // On Windows Node.js, localhost resolves to IPv6 (::1) which causes ECONNREFUSED on local servers like OmniRoute/Ollama
    if (clean.includes('://localhost')) {
      clean = clean.replace('://localhost', '://127.0.0.1');
    }
    return clean;
  }

  private getClient(baseUrl?: string, apiKey?: string): OpenAI {
    const rawBaseUrl = baseUrl || process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
    const effectiveBaseUrl = this.normalizeBaseUrl(rawBaseUrl);
    const effectiveApiKey = (apiKey !== undefined && apiKey !== '' ? apiKey : (process.env.LLM_API_KEY || 'dummy-key')).trim();

    if (!this.client || this.currentBaseUrl !== effectiveBaseUrl || this.currentApiKey !== effectiveApiKey) {
      this.client = new OpenAI({
        baseURL: effectiveBaseUrl,
        apiKey: effectiveApiKey || 'dummy-key',
      });
      this.currentBaseUrl = effectiveBaseUrl;
      this.currentApiKey = effectiveApiKey;
    }
    return this.client;
  }

  public async generateReply(options: LLMGenerateOptions): Promise<string> {
    const settings = db.getSettings();
    const baseUrl = settings.llm_base_url || process.env.LLM_BASE_URL;
    const apiKey = settings.llm_api_key || process.env.LLM_API_KEY;
    const client = this.getClient(baseUrl, apiKey);

    const ownerName = options.ownerName || process.env.OWNER_NAME || 'Chetan';
    const emergencyNumber = (settings.emergency_number || process.env.EMERGENCY_NUMBER || '').trim();
    const currentDate = new Date();
    const currentHour = currentDate.getHours();
    const isNight = currentHour >= 22 || currentHour < 7; // 10 PM to 7 AM
    const timeFormatted = currentDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let systemPrompt = settings.system_prompt
      .replace(/{{contact_name}}/g, options.senderName || 'Friend')
      .replace(/{{owner_name}}/g, ownerName)
      .replace(/{{user_name}}/g, ownerName)
      .replace(/{{current_time}}/g, currentDate.toLocaleString())
      .replace(/{{emergency_number}}/g, emergencyNumber)
      .replace(/{{is_group}}/g, options.isGroup ? 'true' : 'false');

    // Always inject core AI Agent persona directives
    systemPrompt += `\n\n--- [AI AGENT IDENTITY & CHAT RULES] ---\n` +
      `1. IDENTITY: You are ${ownerName}'s personal AI Agent managing his WhatsApp on his behalf!\n` +
      `2. WHO ARE YOU: If anyone asks who you are, what this is, or why you're replying, proudly and casually tell them that you are ${ownerName}'s personal AI agent handling his texts while he is busy or asleep.\n` +
      `3. VIBE & TONE: Keep it cool, witty, friendly, and casual. Talk like a smart, natural modern AI assistant texting a friend on WhatsApp (NOT like a robotic customer service bot or call center script).\n` +
      `4. GREETINGS: For simple greetings (like "hii", "hello", "hey", "sup"), reply casually (e.g. "Hey! What's up?", "Hii! How's it going?"). Never say "How can I assist you today?".\n`;

    if (isNight) {
      systemPrompt +=
        `5. TIME STATUS (NIGHT): The current local time is ${timeFormatted} (night). If the sender asks for ${ownerName} or wants to discuss something, casually let them know that it's late and ${ownerName} is probably sleeping right now, but you can take a message or alert him.\n`;
    } else {
      systemPrompt +=
        `5. TIME STATUS (DAY): The current local time is ${timeFormatted}. If the sender asks for ${ownerName}, casually let them know that ${ownerName} is away or busy right now, but you're here to take a message or help.\n`;
    }

    if (emergencyNumber) {
      systemPrompt +=
        `6. URGENT / WAKE-UP REQUESTS:\n` +
        `   - If the sender says it's urgent, asks to wake him up, or needs him urgently, confirm you are sounding an alarm on his device to wake him up, and include the exact tag [NOTIFY_OWNER] in your reply.\n` +
        `   - Also tell them: "If it's super urgent, you can directly call ${ownerName} on his phone at ${emergencyNumber} to reach him right away!"\n`;
    } else {
      systemPrompt +=
        `6. If the sender asks to notify ${ownerName}, asks to wake him, or says it's urgent, confirm that you will alert him to wake him, and include the exact tag [NOTIFY_OWNER] in your reply.\n`;
    }

    // If there is an active scheduled outreach campaign context for this contact
    if (options.campaignContext && settings.scheduled_reply_mode === 'reply_with_context') {
      systemPrompt += `\n--- [OUTREACH CAMPAIGN CONTEXT] ---\n` +
        `You previously initiated contact with this recipient by sending:\n` +
        `"${options.campaignContext.initial_message}"\n\n` +
        `Specific follow-up instruction for handling replies:\n` +
        `${options.campaignContext.context_note}\n` +
        `Make sure to acknowledge their response contextually without being repetitive or unnatural.`;
    }

    // Format chat messages
    const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add conversation history
    if (options.history && options.history.length > 0) {
      for (const msg of options.history) {
        chatMessages.push({
          role: msg.from_me ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    // Add the latest incoming message
    chatMessages.push({
      role: 'user',
      content: options.incomingText,
    });

    try {
      const response = await client.chat.completions.create({
        model: settings.llm_model || process.env.LLM_MODEL || 'gpt-4o-mini',
        messages: chatMessages,
        temperature: 0.7,
        max_tokens: 600,
      });

      const reply = response.choices[0]?.message?.content?.trim() || '';
      return reply;
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      db.log('ERROR', `LLM Generation failed for ${options.jid}`, { error: errorMsg });
      throw new Error(`LLM Error: ${errorMsg}`);
    }
  }

  public async testCompletion(customBaseUrl?: string, customApiKey?: string, customModel?: string, customPrompt?: string, sampleMessage?: string): Promise<{ success: boolean; reply?: string; error?: string }> {
    const settings = db.getSettings();
    const baseUrl = customBaseUrl || settings.llm_base_url || process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
    const apiKey = customApiKey !== undefined && customApiKey !== '' ? customApiKey : (settings.llm_api_key || process.env.LLM_API_KEY || 'dummy-key');
    const model = customModel || settings.llm_model || process.env.LLM_MODEL || 'gpt-4o-mini';
    const systemPrompt = customPrompt || settings.system_prompt || process.env.SYSTEM_PROMPT || '';
    const userMessage = sampleMessage || 'Hello! Who are you and how can you help me?';

    try {
      const client = new OpenAI({
        baseURL: this.normalizeBaseUrl(baseUrl),
        apiKey: apiKey.trim() || 'dummy-key',
      });

      const response = await client.chat.completions.create({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 300,
      });

      return {
        success: true,
        reply: response.choices[0]?.message?.content || '',
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || String(err),
      };
    }
  }
}

export const llmService = new LLMService();
