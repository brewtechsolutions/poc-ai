/**
 * AnalysisAgent - Specialist agent for conversation analysis and intent/entity extraction.
 * Separate from the search engine (SearchAgent) and language NLP (LanguageAgent).
 * Uses skill-composed prompts and full conversation history; supports fast-path rules and LLM fallback.
 */

import openai, { TOKEN_CONFIG } from '../config/openai.js';
import { AI_ROLES, getRoleConfig } from '../config/ai-registry.js';

/** Skill definitions: name, label, description, and prompt fragment for system prompt composition */
export const SKILLS = {
  consultative_selling: {
    name: 'consultative_selling',
    label: 'Consultative Selling',
    description: 'Guides the user through budget, area, and model preferences to recommend bikes.',
    prompt: `
## Skill: Consultative Selling
- Identify when the user is sharing budget (RM), area/location, or model/brand. Map these to entities: budget, area, location, model, brand.
- If the user asks for recommendations with partial info (e.g. only budget), set missingInfo and suggest one follow-up question (suggestedQuestion) in the user's language.
- Intent bike_recommendation when they share budget/area/model in one go or step by step.`,
  },
  budget_intelligence: {
    name: 'budget_intelligence',
    label: 'Budget Intelligence',
    description: 'Detects and normalizes budget mentions (RM, ranges, flexible wording).',
    prompt: `
## Skill: Budget Intelligence
- Extract budget from phrases like "RM 5000", "5k", "budget 6k", "murah sikit", "below 10k", "around 8 thousand".
- Set entities.budget as a number string (digits only). If user says "cheaper" or "murah sikit", infer from context or set budgetSignal.`,
  },
  local_market_expert: {
    name: 'local_market_expert',
    label: 'Local Market Expert',
    description: 'Understands Malaysian locations and area-based availability.',
    prompt: `
## Skill: Local Market Expert
- Extract area/location from ANY location name mentioned: "Puchong", "KL", "JB", "Penang", "Kota Kinabalu", "Shah Alam", "Indonesia", "Singapore", "Jakarta", "我住Puchong", "area Shah Alam", etc.
- If the user just says a location name (e.g.  "puchong", "KL"), extract it as entities.area and entities.location.
- Even if the intent is area_question, if a location is mentioned, extract it as an entity so we can search with that area context.
- Set entities.area and entities.location. Use for availability and "in your area" recommendations.`,
  },
  context_memory: {
    name: 'context_memory',
    label: 'Context Memory',
    description: 'Uses conversation history to interpret short replies and follow-ups.',
    prompt: `
## Skill: Context Memory
- Use conversationHistory to interpret "2" (model selection), "got others?" (more_options), "yes"/"要" (follow last intent).
- If the last bot message asked for language/budget/area/model and user replies with a short answer, map it to the right intent and entities.`,
  },
  escalation_radar: {
    name: 'escalation_radar',
    label: 'Escalation Radar',
    description: 'Detects when the user wants a human agent or has a complaint.',
    prompt: `
## Skill: Escalation Radar
- Intent agent_request when user says "talk to agent", "human", "真人", "客服", "complaint", "want to speak to someone".
- Set requires_agent_escalation for routing to human handoff.`,
  },
  objection_handler: {
    name: 'objection_handler',
    label: 'Objection Handler',
    description: 'Recognizes price concerns and "too expensive" type messages.',
    prompt: `
## Skill: Objection Handler
- Detect "too expensive", "mahal", "cheaper", "murah sikit" as budget/price refinement; keep intent bike_recommendation and update or set budget.`,
  },
  financing_advisor: {
    name: 'financing_advisor',
    label: 'Financing Advisor',
    description: 'Handles installment and loan questions.',
    prompt: `
## Skill: Financing Advisor
- Intent financing_question for "installment", "loan", "bulkakan", "boleh installment", "pay monthly", "hire purchase".`,
  },
  trade_in_specialist: {
    name: 'trade_in_specialist',
    label: 'Trade-in Specialist',
    description: 'Handles trade-in and old bike exchange questions.',
    prompt: `
## Skill: Trade-in Specialist
- Intent trade_in_question for "trade in", "trade-in", "tukar lama", "old bike", "nak trade in", "exchange".`,
  },
};

/** Default active skill keys when not specified in workflow config */
export const DEFAULT_SKILLS = [
  'consultative_selling',
  'budget_intelligence',
  'local_market_expert',
  'context_memory',
  'escalation_radar',
  'objection_handler',
  'financing_advisor',
  'trade_in_specialist',
];

const DEBUG = process.env.DEBUG === 'true';

/**
 * Parse "RM 5,000, Area, Preferred Model" style message into intent and entities.
 */
function parseStructuredBudgetAreaModel(message, context = {}) {
  const raw = String(message).trim();
  if (!raw) return null;
  const budgetMatch = raw.match(/RM\s*([\d,]+)/i) || raw.match(/^([\d,]+)/);
  if (!budgetMatch) return null;
  const budget = budgetMatch[1].replace(/,/g, '');
  const afterBudget = raw
    .slice(raw.indexOf(budgetMatch[0]) + budgetMatch[0].length)
    .replace(/^[\s,]+/, '')
    .trim();
  if (!afterBudget) return { intent: 'bike_recommendation', entities: { budget }, language: context.language || 'english', confidence: 0.95 };

  const restParts = afterBudget.split(/\s*,\s*/).map(p => p.trim()).filter(Boolean);
  const area = restParts[0] || null;
  const model = restParts.length >= 2 ? restParts.slice(1).join(', ') : null;

  return {
    intent: 'bike_recommendation',
    entities: {
      budget: budget || undefined,
      area: area || undefined,
      location: area || undefined,
      model: model || undefined,
      brand: model || undefined,
    },
    language: context.language || 'english',
    confidence: 0.95,
  };
}

/**
 * AnalysisAgent - main class.
 */
class AnalysisAgent {
  /**
   * Get intent enum from config (workflow.json) or fallback to defaults
   */
  static getIntentEnum(config = {}) {
    if (config.intents && Array.isArray(config.intents)) {
      return config.intents;
    }
    // Fallback defaults (for backward compatibility)
    return [
      'greeting',
      'product_recommendation',
      'more_options',
      'model_selection',
      'more_details',
      'price_inquiry',
      'budget_question',
      'area_question',
      'model_question',
      'specification_question',
      'test_ride_request',
      'test_ride_booking',
      'financing_question',
      'trade_in_question',
      'agent_request',
      'goodbye',
      'out_of_scope',
    ];
  }

  /**
   * Get entity schema from config or fallback to defaults
   */
  static getEntitySchema(config = {}) {
    if (config.entities && Array.isArray(config.entities)) {
      return config.entities;
    }
    // Fallback defaults
    return ['budget', 'area', 'location', 'model', 'brand', 'selected_index'];
  }

  /**
   * Get missing slots from config or fallback to defaults
   */
  static getMissingSlots(config = {}) {
    if (config.missing_slots && Array.isArray(config.missing_slots)) {
      return config.missing_slots;
    }
    // Fallback defaults
    return ['budget', 'area', 'model'];
  }

  static getToolDefinition(config = {}) {
    const intentEnum = this.getIntentEnum(config);
    const entitySchema = this.getEntitySchema(config);
    const missingSlots = this.getMissingSlots(config);
    
    // Build entity properties dynamically
    const entityProperties = {};
    entitySchema.forEach(entity => {
      if (entity === 'selected_index') {
        entityProperties[entity] = { type: 'integer' };
      } else {
        entityProperties[entity] = { type: 'string' };
      }
    });
    return [
      {
        type: 'function',
        function: {
          name: 'classify_message',
          description:
            'Classify the user message into an intent and extract product-sales entities for routing.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              intent: { type: 'string', enum: intentEnum },
              entities: {
                type: 'object',
                additionalProperties: true,
                properties: entityProperties,
              },
              language: { type: 'string', enum: ['english', 'malay', 'chinese'] },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              suggestedQuestion: { type: ['string', 'null'] },
              missingInfo: {
                type: 'array',
                items: { type: 'string', enum: missingSlots },
              },
              hasAskedBudget: { type: 'boolean' },
              hasAskedArea: { type: 'boolean' },
              hasAskedModel: { type: 'boolean' },
              salesInsight: { type: ['string', 'null'] },
              skipAlreadyShownIds: { type: 'array', items: { type: 'string' } },
            },
            required: [
              'intent',
              'entities',
              'language',
              'confidence',
              'suggestedQuestion',
              'missingInfo',
              'hasAskedBudget',
              'hasAskedArea',
              'hasAskedModel',
              'salesInsight',
              'skipAlreadyShownIds',
            ],
          },
        },
      },
    ];
  }

  static normalizePlanFromModel(raw, context, tokensUsed, source, config = {}) {
    const intentEnum = new Set(this.getIntentEnum(config));
    // Use first product-related intent as fallback
    const fallbackIntent = config.intents?.find(i => i.includes('recommendation') || i.includes('inquiry')) || 'product_recommendation';
    const safeIntent = intentEnum.has(raw?.intent) ? raw.intent : fallbackIntent;
    const entities = raw?.entities && typeof raw.entities === 'object' ? raw.entities : {};
    return {
      intent: safeIntent,
      entities,
      language: raw?.language || context.language || 'english',
      confidence: typeof raw?.confidence === 'number' ? raw.confidence : 0.7,
      suggestedQuestion: raw?.suggestedQuestion ?? null,
      missingInfo: Array.isArray(raw?.missingInfo) ? raw.missingInfo : [],
      hasAskedBudget: !!raw?.hasAskedBudget,
      hasAskedArea: !!raw?.hasAskedArea,
      hasAskedModel: !!raw?.hasAskedModel,
      salesInsight: raw?.salesInsight ?? null,
      skipAlreadyShownIds: Array.isArray(raw?.skipAlreadyShownIds) ? raw.skipAlreadyShownIds : (context.skipAlreadyShownIds || []),
      source,
      tokensUsed: tokensUsed ?? 0,
    };
  }

  /**
   * Rule-based fast path: zero tokens, handles obvious intents.
   * @param {object} context - { user_message, conversationHistory, lastIntent, entities, lastShownProducts, language, hasAskedBudget, hasAskedArea, hasAskedModel }
   * @returns {object|null} Plan with intent, entities, etc., or null to fall back to LLM.
   */
  static fastPath(context) {
    const message = (context.user_message || '').trim();
    const lower = message.toLowerCase();
    const trimmed = message.trim();

    // Greeting
    if (/^(hi|hello|hey|halo|hai|你好|您好|嗨)$/i.test(trimmed) || /good morning|good afternoon|good evening/i.test(lower)) {
      if (DEBUG) console.log('[AnalysisAgent] fastPath: greeting');
      return {
        intent: 'greeting',
        entities: {},
        language: context.language || 'english',
        confidence: 0.95,
        suggestedQuestion: null,
        missingInfo: [],
        hasAskedBudget: context.hasAskedBudget || false,
        hasAskedArea: context.hasAskedArea || false,
        hasAskedModel: context.hasAskedModel || false,
        salesInsight: null,
        skipAlreadyShownIds: [],
        source: 'fast_path',
        tokensUsed: 0,
      };
    }

    // Agent / human request
    if (/\bagent\b|客服|找客服|真人|人工|转人工|talk to (a )?human/i.test(lower)) {
      if (DEBUG) console.log('[AnalysisAgent] fastPath: agent_request');
      return {
        intent: 'agent_request',
        entities: {},
        language: context.language || 'english',
        confidence: 0.95,
        suggestedQuestion: null,
        missingInfo: [],
        hasAskedBudget: context.hasAskedBudget || false,
        hasAskedArea: context.hasAskedArea || false,
        hasAskedModel: context.hasAskedModel || false,
        salesInsight: null,
        skipAlreadyShownIds: [],
        source: 'fast_path',
        tokensUsed: 0,
      };
    }

    // Goodbye
    if (/bye|goodbye|see you|exit|quit|再见|拜拜|selamat tinggal/i.test(lower) && trimmed.length < 30) {
      if (DEBUG) console.log('[AnalysisAgent] fastPath: goodbye');
      return {
        intent: 'goodbye',
        entities: {},
        language: context.language || 'english',
        confidence: 0.95,
        suggestedQuestion: null,
        missingInfo: [],
        hasAskedBudget: context.hasAskedBudget || false,
        hasAskedArea: context.hasAskedArea || false,
        hasAskedModel: context.hasAskedModel || false,
        salesInsight: null,
        skipAlreadyShownIds: [],
        source: 'fast_path',
        tokensUsed: 0,
      };
    }

    // Model selection by number (1, 2, 3) from last shown products
    const lastShown = context.lastShownProducts || context.metadata?.lastShownProducts;
    if (lastShown?.length && /^[1-9]\d*\.?$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= lastShown.length) {
        if (DEBUG) console.log('[AnalysisAgent] fastPath: model_selection by number', num);
        return {
          intent: 'model_selection',
          entities: { selected_index: num, ...(context.entities || {}) },
          language: context.language || 'english',
          confidence: 0.95,
          suggestedQuestion: null,
          missingInfo: [],
          hasAskedBudget: context.hasAskedBudget || false,
          hasAskedArea: context.hasAskedArea || false,
          hasAskedModel: context.hasAskedModel || false,
          salesInsight: null,
          skipAlreadyShownIds: [],
          source: 'fast_path',
          tokensUsed: 0,
        };
      }
    }

    return null;
  }

  /**
   * Build system prompt from config, active skills, and context.
   * If config.system_prompt is provided, use it; otherwise build from skills.
   */
  static buildSystemPrompt(activeSkillNames, context, config = {}) {
    const skills = activeSkillNames
      .map(name => SKILLS[name])
      .filter(Boolean);
    const skillBlocks = skills.map(s => s.prompt).join('\n');
    const lang = context.language || 'english';
    
    // Use system prompt from config if provided, otherwise build from skills
    const basePrompt = config.system_prompt || 
      `You are a WhatsApp sales assistant. Use the skills below to classify messages and extract entities for routing. Always call the tool classify_message and fill its schema accurately.`;
    
    return `${basePrompt}

${skillBlocks}

Conversation language: ${lang}. Last intent: ${context.lastIntent || 'none'}. Existing entities: ${JSON.stringify(context.entities || {})}.`;
  }

  /**
   * Analyze user message with full conversation context. Tries fast path first, then LLM.
   * @param {object} context - Same as workflow executionContext (user_message, conversationHistory, entities, lastIntent, lastShownProducts, language, hasAskedBudget, hasAskedArea, hasAskedModel, skipAlreadyShownIds)
   * @param {object} options - { activeSkills: string[], nodes: Map } (nodes optional, for future use)
   * @returns {Promise<object>} Plan: intent, entities, language, confidence, suggestedQuestion, missingInfo, hasAskedBudget, hasAskedArea, hasAskedModel, salesInsight, skipAlreadyShownIds, source.
   */
  static async analyze(context, options = {}) {
    const activeSkills = options.activeSkills || DEFAULT_SKILLS;
    const config = options.config || {}; // Config from workflow.json node.config
    const fast = this.fastPath(context);
    if (fast) return fast;

    const systemPrompt = this.buildSystemPrompt(activeSkills, context, config);
    const history = (context.conversationHistory || []).slice(-6);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      })),
      { role: 'user', content: (context.user_message || '').trim() },
    ].filter(m => m.content);

    try {
      if (DEBUG) console.log('[AnalysisAgent] LLM analyze for:', (context.user_message || '').substring(0, 50));

      // Get config from registry (can be overridden by options)
      const roleConfig = getRoleConfig(AI_ROLES.ANALYZER);
      const model = options.model || config.model || roleConfig.model;
      const temperature = options.temperature ?? config.temperature ?? roleConfig.temperature;
      const maxTokens = options.max_tokens || config.max_tokens || roleConfig.maxTokens;

      // Primary path: tool-call structured output
      const toolCompletion = await openai.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        tools: this.getToolDefinition(config),
        tool_choice: { type: 'function', function: { name: 'classify_message' } },
      });

      const tokensUsed = toolCompletion.usage?.total_tokens || 0;
      const toolCall = toolCompletion.choices?.[0]?.message?.tool_calls?.[0];
      const args = toolCall?.function?.arguments;
      if (toolCall?.function?.name === 'classify_message' && typeof args === 'string' && args.trim()) {
        const raw = JSON.parse(args);
        const plan = this.normalizePlanFromModel(raw, context, tokensUsed, 'llm', config);
        if (DEBUG) console.log('[AnalysisAgent] Tool intent:', plan.intent);
        return plan;
      }

      // Safety net: force json_object response_format if tool-call output is missing/malformed
      const jsonCompletion = await openai.chat.completions.create({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      });
      const jsonTokensUsed = jsonCompletion.usage?.total_tokens || 0;
      const content = JSON.parse(jsonCompletion.choices[0].message.content || '{}');
      const plan = this.normalizePlanFromModel(content, context, jsonTokensUsed, 'llm', config);
      if (DEBUG) console.log('[AnalysisAgent] JSON intent:', plan.intent);
      return plan;
    } catch (err) {
      console.error('[AnalysisAgent] LLM error:', err.message);
      const fallbackIntent = config.intents?.find(i => i.includes('recommendation') || i.includes('inquiry')) || 'product_recommendation';
      return {
        intent: fallbackIntent,
        entities: {},
        language: context.language || 'english',
        confidence: 0.3,
        suggestedQuestion: null,
        missingInfo: [],
        hasAskedBudget: context.hasAskedBudget || false,
        hasAskedArea: context.hasAskedArea || false,
        hasAskedModel: context.hasAskedModel || false,
        salesInsight: null,
        skipAlreadyShownIds: context.skipAlreadyShownIds || [],
        source: 'llm',
        tokensUsed: 0,
        error: err.message,
      };
    }
  }

  static getSkillInfo(name) {
    return SKILLS[name] || null;
  }

  static listSkills() {
    return Object.keys(SKILLS);
  }
}

export default AnalysisAgent;
