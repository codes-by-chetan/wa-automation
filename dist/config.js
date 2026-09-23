"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.CONFIG = {
    PORT: parseInt(process.env.PORT || '3000', 10),
    HOST: process.env.HOST || '0.0.0.0',
    DATA_DIR: path_1.default.resolve(process.cwd(), 'data'),
    DB_PATH: path_1.default.resolve(process.cwd(), 'data', 'automation.sqlite'),
    AUTH_DIR: path_1.default.resolve(process.cwd(), 'data', 'auth_baileys'),
    DEFAULT_LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    DEFAULT_LLM_API_KEY: process.env.LLM_API_KEY || '',
    DEFAULT_LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
    DEFAULT_SYSTEM_PROMPT: process.env.SYSTEM_PROMPT ||
        'You are a smart, professional, and friendly WhatsApp AI assistant. ' +
            'Provide concise, natural, and helpful replies suitable for chat messaging. ' +
            'Keep your formatting clean and readable on mobile devices.',
};
