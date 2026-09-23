import OpenAI from 'openai';
import { db, CampaignContext, ChatMessage } from '../storage/db';

export interface LLMGenerateOptions {
  jid: string;
  senderName?: string;
  isGroup: boolean;
  incomingText: string;
  history?: ChatMessage[];
  campaignContext?: CampaignContext | null;
}

export class LLMService {
  private client: OpenAI | null = null;
  private currentBaseUrl: string = '';
  private currentApiKey: string = '';

  private getClient(baseUrl: string, apiKey: string): OpenAI {
    if (!this.client || this.currentBaseUrl !== baseUrl || this.currentApiKey !== apiKey) {
      this.client = new OpenAI({
        baseURL: baseUrl.trim() || 'https://api.openai.com/v1',
        apiKey: apiKey.trim() || 'dummy-key', // Some local endpoints like Ollama/LocalAI allow dummy keys
      });
      this.currentBaseUrl = baseUrl;
      this.currentApiKey = apiKey;
    }
    return this.client;
  }

  public async generateReply(options: LLMGenerateOptions): Promise<string> {
    const settings = db.getSettings();
    const client = this.getClient(settings.llm_base_url, settings.llm_api_key);

    const now = new Date().toLocaleString();
    let systemPrompt = settings.system_prompt
      .replace(/{{contact_name}}/g, options.senderName || 'Friend')
      .replace(/{{current_time}}/g, now)
      .replace(/{{is_group}}/g, options.isGroup ? 'true' : 'false');

    // If there is an active scheduled outreach campaign context for this contact
    if (options.campaignContext && settings.scheduled_reply_mode === 'reply_with_context') {
      systemPrompt += `\n\n--- [OUTREACH CAMPAIGN CONTEXT] ---\n` +
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
        model: settings.llm_model || 'gpt-4o-mini',
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
    const baseUrl = customBaseUrl || settings.llm_base_url;
    const apiKey = customApiKey !== undefined ? customApiKey : settings.llm_api_key;
    const model = customModel || settings.llm_model;
    const systemPrompt = customPrompt || settings.system_prompt;
    const userMessage = sampleMessage || 'Hello! Who are you and how can you help me?';

    try {
      const client = new OpenAI({
        baseURL: baseUrl.trim() || 'https://api.openai.com/v1',
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
