import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Token optimization settings
export const TOKEN_CONFIG = {
  MAX_TOKENS_PER_REQUEST: parseInt(process.env.MAX_TOKENS_PER_REQUEST) || 500,
  TOKEN_BUDGET_PER_CONVERSATION: parseInt(process.env.TOKEN_BUDGET_PER_CONVERSATION) || 2000,
  TEMPERATURE: {
    STRICT: 0.2,      // For classification, ranking
    BALANCED: 0.3,    // For recommendations
    CREATIVE: 0.4,    // For general Q&A
  },
};

export default openai;
