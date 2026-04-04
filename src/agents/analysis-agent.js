/**
 * AnalysisAgent - Specialist agent for conversation analysis and intent/entity extraction.
 * Separate from the search engine (SearchAgent) and language NLP (LanguageAgent).
 * Uses skill-composed prompts and full conversation history; supports fast-path rules and LLM fallback.
 */

import openai, { TOKEN_CONFIG } from '../config/openai.js';
import { AI_ROLES, getRoleConfig } from '../config/ai-registry.js';
import { resolveSelection } from '../utils/session-option-sets.js';

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
- Set entities.area and entities.location when a location is detected.
- IMPORTANT: If the user message contains ONLY a location name with no buying or searching intent (e.g. just "KLCC", "USA", "Penang"), set intent to area_question and set missingInfo: ["productType"] — do NOT trigger a product search.
- Only set intent to bike_recommendation if the user has expressed a clear buying or searching intent alongside the location (e.g. "I want bike in KL", "cari motor dekat Puchong", "show me bikes near KLCC").
- If the user says ONLY a location, reply by asking what they are looking for in that area.`,
  },
  context_memory: {
    name: 'context_memory',
    label: 'Context Memory',
    description: 'Uses conversation history to interpret short replies and follow-ups.',
    prompt: `
## Skill: Context Memory
- Use conversationHistory to interpret "2" (model selection), "got others?" (more_options), "yes"/"要" (follow last intent).
- If the last bot message asked for language/budget/area/model and user replies with a short answer, map it to the right intent and entities.
- Asking to SEE or REPEAT the bike list is NOT a compare: "show me the list", "show the list", "show list", "list again", "what bikes did you show", "senarai lagi", "列表呢" → intent **more_options** (or bike_recommendation if budget/area still missing). Never set compare_bikes or entities.compare_scope for these — compare_bikes is only when they explicitly compare models or say "compare all".`,
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
  static getToolDefinition(config = {}) {
    const intents = Array.isArray(config.intents) ? config.intents : [];
    const languages = Array.isArray(config.languages) ? config.languages : ['english'];
    const missingSlots = Array.isArray(config.missing_slots) ? config.missing_slots : [];

    const entityProperties = {};
    (config.entities || []).forEach(entity => {
      if (!entity) return;
      if (typeof entity === 'string') {
        entityProperties[entity] = { type: entity === 'selected_index' ? 'integer' : 'string' };
        return;
      }
      if (!entity.name) return;
      entityProperties[entity.name] = { type: entity.type || 'string' };
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
              intent: { type: 'string', enum: intents },
              entities: {
                type: 'object',
                additionalProperties: true,
                properties: entityProperties,
              },
              language: { type: 'string', enum: languages },
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
    const intentSet = new Set(config.intents || []);
    const fallbackIntent = config.fallback_intent || config.intents?.[0];
    if (!fallbackIntent) {
      throw new Error('[AnalysisAgent] config.fallback_intent is required');
    }
    const safeIntent = intentSet.has(raw?.intent) ? raw.intent : fallbackIntent;
    const entities = raw?.entities && typeof raw.entities === 'object' ? raw.entities : {};

    return {
      intent: safeIntent,
      entities,
      // Respect session-locked language first; do not overwrite with model detection.
      language: context.language || raw?.language || config.languages?.[0] || 'english',
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
  static fastPath(context, config = {}) {
    const message = (context.user_message || '').trim();
    const trimmed = message;

    const optionSets = context.optionSets || context.metadata?.optionSets;
    const hasLedger = Array.isArray(optionSets) && optionSets.length > 0;
    const isNumericPick = /^[1-9]\d*\.?$/.test(trimmed);
    const isNamePick =
      trimmed.length > 1 &&
      trimmed.length <= 80 &&
      !trimmed.includes('?') &&
      !isNumericPick;
    const hasCompareKeyword = /compare|vs\.?|versus|bandingkan|比较/i.test(trimmed);

    if (context.pendingCompare && hasCompareKeyword) {
      if (DEBUG) {
        console.log('[AnalysisAgent] fastPath: new compare request detected, clearing pendingCompare');
      }
      context.pendingCompare = null;
    }

    if (context.pendingCompare) {
      const looksLikeComparePhrase =
        /\b(compare|versus|vs\.?|bandingkan)\b/i.test(trimmed) ||
        /\s+(and|or|vs\.?|versus|atau)\s+/i.test(trimmed);
      const isContinuationPick =
        (isNumericPick || isNamePick) && !looksLikeComparePhrase && !hasCompareKeyword;
      if (isContinuationPick) {
        if (DEBUG) console.log('[AnalysisAgent] fastPath: pending compare continuation', trimmed);
        return this._makeFastResult(
          'compare_bikes',
          {
            ...(context.entities || {}),
            pendingCompare: context.pendingCompare,
            selectedRef: trimmed,
          },
          context,
          config,
        );
      }
    }

    // Compare modes (e.g. "compare all") before generic `compare` fast_path_rule — otherwise the
    // broad compare pattern wins first and we lose entities.compare_scope.
    for (const rule of config.compare_mode_rules || []) {
      if (!rule?.pattern || !rule.compare_scope) continue;
      if (!hasLedger) continue;
      try {
        const re = new RegExp(rule.pattern, rule.flags || 'i');
        if (!re.test(trimmed)) continue;
        if (DEBUG) {
          console.log('[AnalysisAgent] fastPath: compare mode', rule.compare_scope);
        }
        return this._makeFastResult(
          'compare_bikes',
          { ...(context.entities || {}), compare_scope: rule.compare_scope },
          context,
          config,
        );
      } catch (err) {
        if (DEBUG) {
          console.warn('[AnalysisAgent] Invalid compare_mode_rule regex:', rule.pattern, err.message);
        }
      }
    }

    for (const rule of (config.fast_path_rules || [])) {
      if (!rule || !rule.pattern || !rule.intent) continue;
      if (rule.maxLength && message.length > rule.maxLength) continue;
      try {
        const regex = new RegExp(rule.pattern, rule.flags || '');
        if (!regex.test(message)) continue;
        if (DEBUG) console.log('[AnalysisAgent] fastPath:', rule.intent);
        return this._makeFastResult(rule.intent, {}, context, config);
      } catch (err) {
        if (DEBUG) console.warn('[AnalysisAgent] Invalid fast_path_rule regex:', rule.pattern, err.message);
      }
    }

    // Model selection via option history ledger (newest matching set first)
    if (hasLedger && (isNumericPick || isNamePick)) {
      const latestSet = optionSets[optionSets.length - 1];

      if (isNumericPick) {
        // Numeric picks: ONLY check the latest option set — never walk history
        if (latestSet) {
          const num = parseInt(trimmed, 10);
          const items = Array.isArray(latestSet.items) ? latestSet.items : [];
          const item = items.find(it => it.displayIndex === num);

          if (item) {
            if (DEBUG) {
              console.log(
                '[AnalysisAgent] fastPath: numeric selection',
                item.stableId,
                'from latest set',
                latestSet.id,
              );
            }
            return this._makeFastResult(
              'model_selection',
              {
                ...(context.entities || {}),
                selected_index: item.displayIndex,
                selected_id: item.stableId,
                selected_title: item.title,
                resolved_from_set: latestSet.id,
              },
              context,
              config,
            );
          }

          // Number is out of range for latest set — use top-level clarificationMessage so merge does not drop it
          const clarifyMsg =
            items.length > 0
              ? `Please pick a number between 1 and ${items.length} from the latest list.`
              : 'Please pick a valid number from the list.';
          return this._makeClarifySelectionResult(context, config, clarifyMsg);
        }
      }

      if (isNamePick) {
        // Name picks: walk full history — user might refer to an older item by name
        const ledgerContext = { optionSets };
        const resolved = resolveSelection(ledgerContext, trimmed);

        if (resolved) {
          if (DEBUG) {
            console.log(
              '[AnalysisAgent] fastPath: name selection',
              resolved.item.stableId,
              'from set',
              resolved.set.id,
            );
          }
          return this._makeFastResult(
            'model_selection',
            {
              ...(context.entities || {}),
              selected_index: resolved.item.displayIndex,
              selected_id: resolved.item.stableId,
              selected_title: resolved.item.title,
              resolved_from_set: resolved.set.id,
            },
            context,
            config,
          );
        }
      }
    }

    // Fallback: single last list only (e.g. terminal / WhatsApp without ledger)
    const lastShown = context.lastShownProducts || context.metadata?.lastShownProducts;
    if (lastShown?.length && /^[1-9]\d*\.?$/.test(message)) {
      const num = parseInt(message, 10);
      if (num >= 1 && num <= lastShown.length) {
        if (DEBUG) console.log('[AnalysisAgent] fastPath: model_selection by number', num);
        return this._makeFastResult(
          'model_selection',
          { selected_index: num, ...(context.entities || {}) },
          context,
          config,
        );
      }
    }

    return null;
  }

  static _makeFastResult(intent, entities, context, config = {}) {
    return {
      intent,
      entities,
      language: context.language || config.languages?.[0] || 'english',
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

  /** Same shape as _makeFastResult but intent fixed; message is not stored in entities (avoids merge loss in workflow). */
  static _makeClarifySelectionResult(context, config, clarificationMessage) {
    return {
      intent: 'clarify_selection',
      entities: context.entities || {},
      clarificationMessage,
      language: context.language || config.languages?.[0] || 'english',
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

  /**
   * Build system prompt from config, active skills, and context.
   */
  static buildSystemPrompt(config = {}, context = {}) {
    const mergedSkills = { ...SKILLS };
    for (const skill of (config.skills || [])) {
      if (skill?.name) mergedSkills[skill.name] = skill;
    }

    const activeSkillNames = config.active_skills?.length ? config.active_skills : DEFAULT_SKILLS;
    const skills = activeSkillNames
      .map(name => mergedSkills[name])
      .filter(Boolean);
    const skillBlocks = skills.map(s => s.prompt).join('\n');
    const lang = context.language || config.languages?.[0] || 'english';

    const basePrompt = config.system_prompt;
    if (!basePrompt) {
      throw new Error('[AnalysisAgent] config.system_prompt is required');
    }

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
    const config = options.config || {}; // Config from workflow.json node.config
    const fast = this.fastPath(context, config);
    if (fast) return fast;

    const systemPrompt = this.buildSystemPrompt(config, context);
    const parsedHistoryWindow = Number(config.history_window ?? process.env.ANALYSIS_HISTORY_LIMIT ?? 6);
    const historyWindow = Number.isFinite(parsedHistoryWindow) && parsedHistoryWindow >= 0
      ? Math.floor(parsedHistoryWindow)
      : 6;
    const history = (context.conversationHistory || []).slice(-historyWindow);
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
      const fallbackIntent = config.fallback_intent || config.intents?.[0] || 'product_recommendation';
      return {
        intent: fallbackIntent,
        entities: {},
        language: context.language || config.languages?.[0] || 'english',
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
