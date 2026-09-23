"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.llmService = exports.LLMService = void 0;
const openai_1 = __importDefault(require("openai"));
const db_1 = require("../storage/db");
class LLMService {
    client = null;
    currentBaseUrl = '';
    currentApiKey = '';
    getClient(baseUrl, apiKey) {
        if (!this.client || this.currentBaseUrl !== baseUrl || this.currentApiKey !== apiKey) {
            this.client = new openai_1.default({
                baseURL: baseUrl.trim() || 'https://api.openai.com/v1',
                apiKey: apiKey.trim() || 'dummy-key', // Some local endpoints like Ollama/LocalAI allow dummy keys
            });
            this.currentBaseUrl = baseUrl;
            this.currentApiKey = apiKey;
        }
        return this.client;
    }
    async generateReply(options) {
        const settings = db_1.db.getSettings();
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
        const chatMessages = [
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
        }
        catch (err) {
            const errorMsg = err?.message || String(err);
            db_1.db.log('ERROR', `LLM Generation failed for ${options.jid}`, { error: errorMsg });
            throw new Error(`LLM Error: ${errorMsg}`);
        }
    }
    async testCompletion(customBaseUrl, customApiKey, customModel, customPrompt, sampleMessage) {
        const settings = db_1.db.getSettings();
        const baseUrl = customBaseUrl || settings.llm_base_url;
        const apiKey = customApiKey !== undefined ? customApiKey : settings.llm_api_key;
        const model = customModel || settings.llm_model;
        const systemPrompt = customPrompt || settings.system_prompt;
        const userMessage = sampleMessage || 'Hello! Who are you and how can you help me?';
        try {
            const client = new openai_1.default({
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
        }
        catch (err) {
            return {
                success: false,
                error: err?.message || String(err),
            };
        }
    }
}
exports.LLMService = LLMService;
exports.llmService = new LLMService();
