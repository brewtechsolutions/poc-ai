/**
 * AnalysisAgent - Specialist agent for conversation analysis and intent/entity extraction.
 * Separate from the search engine (SearchAgent) and language NLP (LanguageAgent).
 * Uses skill-composed prompts and full conversation history; supports fast-path rules and LLM fallback.
 */

import openai, { TOKEN_CONFIG } from '../config/openai.js';

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
- Extract area/location from "Puchong", "KL", "JB", "Penang", "Kota Kinabalu", "我住Puchong", "area Shah Alam".
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
 * Parse "RM 5,000, Puchong, Yamaha Ego" style message into intent and entities.
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
   * Rule-based fast path: zero tokens, handles obvious intents.
   * @param {object} context - { user_message, conversationHistory, lastIntent, entities, lastShownProducts, language, hasAskedBudget, hasAskedArea, hasAskedModel }
   * @returns {object|null} Plan with intent, entities, etc., or null to fall back to LLM.
   */
  static fastPath(context) {
    const message = (context.user_message || '').trim();
    const lower = message.toLowerCase();
    const trimmed = message.trim();
    const history = Array.isArray(context.conversationHistory) ? context.conversationHistory : [];
    let lastBotMessage = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role === 'assistant' && typeof history[i].content === 'string') {
        lastBotMessage = history[i].content;
        break;
      }
    }

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

    // More options
    if (/got others?|any others?|more options?|show more|ada lain|还有别的|其他(的)?(选择|推荐)?/i.test(lower) || /show (me )?all (the )?(bikes?|models?)/i.test(lower)) {
      const existingIds = (context.lastShownProducts || []).map(p => p.id).filter(Boolean);
      if (DEBUG) console.log('[AnalysisAgent] fastPath: more_options, skipAlreadyShownIds=', existingIds.length);
      return {
        intent: 'more_options',
        entities: context.entities || context.metadata?.entities || {},
        language: context.language || 'english',
        confidence: 0.9,
        suggestedQuestion: null,
        missingInfo: [],
        hasAskedBudget: context.hasAskedBudget || false,
        hasAskedArea: context.hasAskedArea || false,
        hasAskedModel: context.hasAskedModel || false,
        salesInsight: null,
        skipAlreadyShownIds: existingIds,
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

    // Financing
    if (/installment|loan|bulkakan|boleh installment|pay monthly|hire purchase|分期|贷款/i.test(lower)) {
      if (DEBUG) console.log('[AnalysisAgent] fastPath: financing_question');
      return {
        intent: 'financing_question',
        entities: context.entities || {},
        language: context.language || 'english',
        confidence: 0.9,
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

    // Trade-in
    if (/trade\s*in|tukar lama|old bike|nak trade in|exchange|tradein|trade-in|以旧换新/i.test(lower)) {
      if (DEBUG) console.log('[AnalysisAgent] fastPath: trade_in_question');
      return {
        intent: 'trade_in_question',
        entities: context.entities || {},
        language: context.language || 'english',
        confidence: 0.9,
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

    // Test ride
    if (/test ride|ujian memandu|预约试驾|试驾|book (a )?test ride/i.test(lower)) {
      if (DEBUG) console.log('[AnalysisAgent] fastPath: test_ride_request');
      return {
        intent: 'test_ride_request',
        entities: context.entities || {},
        language: context.language || 'english',
        confidence: 0.9,
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

    // More details
    if (/more detail|tell me more|full specs?|详细|maklumat lanjut/i.test(lower) && trimmed.length < 60) {
      if (DEBUG) console.log('[AnalysisAgent] fastPath: more_details');
      return {
        intent: 'more_details',
        entities: context.entities || {},
        language: context.language || 'english',
        confidence: 0.9,
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

    // Structured "RM 5,000, Puchong, Yamaha Ego"
    const structured = parseStructuredBudgetAreaModel(message, context);
    if (structured) {
      if (DEBUG) console.log('[AnalysisAgent] fastPath: bike_recommendation (structured)');
      return {
        ...structured,
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

    // Brand-only (e.g. "i want suzuki", "ada honda?", "any yamaha?")
    const brandOnlyMatch = lower.match(/\b(honda|yamaha|modenas|suzuki|kawasaki|ktm|benelli|demak)\b/i);
    const hasBudgetAlready = /\b(rm|myr)\s*\d|budget|bajet|预算/i.test(lower);
    if (brandOnlyMatch && !hasBudgetAlready) {
      if (DEBUG) console.log('[AnalysisAgent] fastPath: bike_recommendation (brand only)');
      return {
        intent: 'bike_recommendation',
        entities: {
          ...(context.entities || {}),
          brand: brandOnlyMatch[1],
          budget: '',
          area: '',
          location: '',
          model: '',
        },
        language: context.language || 'english',
        confidence: 0.9,
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

    // Budget-only (more robust patterns)
    const budgetPatterns = [
      /\b(?:rm|myr)\s*([\d,]+)/i, // "RM5000", "MYR 5,000"
      /budget[^0-9]*([\d,]+)/i, // "budget of 5000", "my budget is 5000"
      /(?:have|got|only|around|about)[^0-9]*([\d,]+)\s*(?:rm|myr|ringgit)?/i, // "i have 5000", "around 6000"
      /([\d,]+)\s*(?:rm|myr|ringgit)/i, // "5000rm", "6000 ringgit"
    ];

    let budgetValue = null;
    for (const pattern of budgetPatterns) {
      const m = message.match(pattern);
      if (m) {
        const val = (m[1] || '').replace(/,/g, '');
        if (val && parseInt(val, 10) > 100) {
          budgetValue = val;
          break;
        }
      }
    }

    if (budgetValue) {
      if (DEBUG) console.log('[AnalysisAgent] fastPath: bike_recommendation (budget only)', budgetValue);
      return {
        intent: 'bike_recommendation',
        entities: {
          ...(context.entities || {}),
          budget: budgetValue,
          area: '',
          location: '',
          model: '',
          brand: '',
        },
        language: context.language || 'english',
        confidence: 0.9,
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

    return null;
  }

  /**
   * Build system prompt from active skills and context.
   */
  static buildSystemPrompt(activeSkillNames, context) {
    const skills = activeSkillNames
      .map(name => SKILLS[name])
      .filter(Boolean);
    const skillBlocks = skills.map(s => s.prompt).join('\n');
    const lang = context.language || 'english';
    return `You are a motorcycle sales assistant for MotorShop Malaysia. Analyze the user message and conversation context. Use the skills below to classify intent and extract entities. Respond ONLY with valid JSON.

${skillBlocks}

## Output format (strict JSON)
Return exactly: {
  "intent": "<one of: greeting, bike_recommendation, more_options, model_selection, more_details, price_inquiry, budget_question, area_question, model_question, specification_question, test_ride_request, test_ride_booking, financing_question, trade_in_question, agent_request, goodbye>",
  "entities": { "budget": "", "area": "", "location": "", "model": "", "brand": "" },
  "language": "english|malay|chinese",
  "confidence": 0.0-1.0,
  "suggestedQuestion": "one short follow-up question in user language if missing_info is non-empty, else null",
  "missingInfo": ["budget"|"area"|"model"],
  "hasAskedBudget": boolean,
  "hasAskedArea": boolean,
  "hasAskedModel": boolean,
  "salesInsight": null or one short sentence
}

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
    const fast = this.fastPath(context);
    if (fast) return fast;

    const systemPrompt = this.buildSystemPrompt(activeSkills, context);
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
      if (DEBUG) console.log('[AnalysisAgent] LLM fallback for:', (context.user_message || '').substring(0, 50));
      const completion = await openai.chat.completions.create({
        model: options.model || 'gpt-4o-mini',
        messages,
        temperature: options.temperature ?? TOKEN_CONFIG.TEMPERATURE.STRICT,
        max_tokens: options.max_tokens || 250,
        response_format: { type: 'json_object' },
      });
      const content = JSON.parse(completion.choices[0].message.content || '{}');
      const tokensUsed = completion.usage?.total_tokens || 0;
      const plan = {
        intent: content.intent || 'general_question',
        entities: content.entities || {},
        language: content.language || context.language || 'english',
        confidence: typeof content.confidence === 'number' ? content.confidence : 0.7,
        suggestedQuestion: content.suggestedQuestion || null,
        missingInfo: Array.isArray(content.missingInfo) ? content.missingInfo : [],
        hasAskedBudget: !!content.hasAskedBudget,
        hasAskedArea: !!content.hasAskedArea,
        hasAskedModel: !!content.hasAskedModel,
        salesInsight: content.salesInsight || null,
        skipAlreadyShownIds: context.skipAlreadyShownIds || [],
        source: 'llm',
        tokensUsed,
      };
      if (DEBUG) console.log('[AnalysisAgent] LLM intent:', plan.intent);
      return plan;
    } catch (err) {
      console.error('[AnalysisAgent] LLM error:', err.message);
      return {
        intent: 'general_question',
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
