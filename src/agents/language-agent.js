import openai, { TOKEN_CONFIG } from '../config/openai.js';
import { resolveSelection } from '../utils/session-option-sets.js';

/**
 * LanguageAgent
 * Handles language selection, NLP intent/entity extraction, and intent routing.
 * Extracted from WorkflowEngine to keep orchestration separate from language logic.
 */
class LanguageAgent {
  /**
   * Language selector: enforce "choose language first".
   * If context.language is set, continue; if user message is 1/2/3 or language name,
   * set language and go to greeting; else prompt to choose.
   */
  static handleLanguageSelector(node, context) {
    const config = node.config || {};
    const nextIfSet = config.next_if_set || 'message_classifier';
    const nextAfterSelect = config.next_after_select || 'greeting_handler';
    const nextPrompt = config.next_prompt || 'language_selection_prompt';

    // If language has been locked earlier in the conversation, never change it again.
    if (context.languageLocked && context.language) {
      if (process.env.DEBUG === 'true') {
        console.log(`   [LanguageSelector] Language locked as: ${context.language}`);
      }
      return { data: { language: context.language }, tokensUsed: 0, next: nextIfSet };
    }

    const existingLanguage = context.language || context.metadata?.language;
    if (existingLanguage && !context.languageLocked) {
      const normalized = String(existingLanguage).toLowerCase();
      const langMap = { en: 'english', bm: 'malay', zh: 'chinese' };
      const normalizedLang = langMap[normalized] || normalized;
      if (['english', 'malay', 'chinese'].includes(normalizedLang)) {
        context.language = normalizedLang;
        if (process.env.DEBUG === 'true') {
          console.log(`   [LanguageSelector] Language already set: ${context.language}`);
        }
        return { data: { language: context.language }, tokensUsed: 0, next: nextIfSet };
      }
    }

    const raw = (context.user_message || '').trim();
    const msg = raw.toLowerCase();

    // Heuristic: if user message looks like a real query (budget, bikes, etc.)
    // and NOT like a language selection, assume English and continue instead of
    // re-asking for language. This fixes cases like "but I only have the budget of rm5,000"
    // right after greeting.
    const looksLikeBudgetOrBikeQuery =
      /\brm\s*\d/i.test(msg) ||
      /预算|budget|bajet/i.test(msg) ||
      /\b(bike|motor|kapcai|scooter|motosikal|摩托|摩多)\b/i.test(msg);
    const looksLikeLanguageChoice =
      /^1$|^2$|^3$|^english$|^malay$|^bm$|^bahasa$|^chinese$|^zh$|中文/i.test(msg);

    if (!context.languageLocked && looksLikeBudgetOrBikeQuery && !looksLikeLanguageChoice) {
      context.language = context.language || 'english';
      if (process.env.DEBUG === 'true') {
        console.log(
          `   [LanguageSelector] Detected content message (budget/bike) without explicit language selection; defaulting to ${context.language} and continuing (not locking language)`,
        );
      }
      return { data: { language: context.language }, tokensUsed: 0, next: nextIfSet };
    }

    let selected = null;
    if (/^1$|^english$|^en$/i.test(msg)) selected = 'english';
    else if (/^2$|^malay$|^bm$|^bahasa$/i.test(msg)) selected = 'malay';
    else if (/^3$|^chinese$|^zh$|^中文$/i.test(msg) || msg.includes('chinese') || msg.includes('中文')) selected = 'chinese';

    if (selected) {
      context.language = selected;
      context.languageLocked = true;
      if (process.env.DEBUG === 'true') {
        console.log(`   [LanguageSelector] User selected language: ${selected}`);
      }
      return {
        data: { language: selected },
        tokensUsed: 0,
        next: nextAfterSelect,
      };
    }

    if (process.env.DEBUG === 'true') {
      console.log(`   [LanguageSelector] No language set, prompting user to choose`);
    }
    return {
      data: { needLanguageChoice: true },
      tokensUsed: 0,
      next: nextPrompt,
    };
  }

  /**
   * Extract model name from messages like "i want ego s", "looking for yamaha ego", "ego s".
   */
  static extractModelNameFromMessage(text) {
    const t = (text || '').trim();
    if (!t) return '';
    const patterns = [
      /(?:i want|i'm looking for|looking for|do you have|got any|have you got|show me)\s+(.+)/i,
      /(?:can i (?:see|get)|would like)\s+(.+)/i,
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m && m[1]) return m[1].trim().replace(/\?|\.$/, '').slice(0, 80);
    }
    return t.length <= 80 ? t : t.slice(0, 80);
  }

  /**
   * Detect "budget, area, model" reply (e.g. "RM 5,000, Puchong, Yamaha Ego") and parse without calling API.
   * Returns null if message doesn't match this format.
   * Handles comma inside budget (e.g. 5,000) by extracting budget first, then splitting the rest for area/model.
   */
  static parseStructuredBudgetAreaModel(message, context = {}) {
    const raw = String(message).trim();
    if (!raw) return null;
    const hasRm = /\bRM\s*\d/i.test(raw) || /^\s*\d[\d,\s]*\d/.test(raw) || /^\s*\d+/.test(raw);
    if (!hasRm) return null;

    const budgetMatch = raw.match(/RM\s*([\d,]+)/i) || raw.match(/^([\d,]+)/);
    if (!budgetMatch) return null;
    const budget = budgetMatch[1].replace(/,/g, '');
    const afterBudget = raw
      .slice(raw.indexOf(budgetMatch[0]) + budgetMatch[0].length)
      .replace(/^[\s,]+/, '')
      .trim();
    if (!afterBudget) return null;

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
   * Main NLP handler: rule-based shortcuts + LLM intent/entity extraction.
   * Depends on the workflow nodes map to read escalation content words.
   */
  static async handleNLP(node, context, { nodes }) {
    const message = context.user_message || context.lastResult?.data?.message;

    if (!message) {
      console.error('[NLP] No message found in context');
      return {
        data: {
          intent: 'general_question',
          entities: {},
          confidence: 0.3,
          requires_product_search: false,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.3,
        error: 'No message to process',
      };
    }

    const lower = message.toLowerCase().trim();
    const trimmed = message.trim();

    // Look at recent conversation to understand short replies like "想", "要", "ok"
    const history = Array.isArray(context.conversationHistory) ? context.conversationHistory : [];
    let lastBotMessage = null;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i] && history[i].role === 'assistant' && typeof history[i].content === 'string') {
        lastBotMessage = history[i].content;
        break;
      }
    }

    // If user sends a first message that clearly looks like a budget statement,
    // don't treat it as a greeting. Force bike_recommendation so we go straight
    // into the search flow instead of showing the greeting template again.
    const looksLikeBudgetFirstMessage =
      (context.lastIntent == null || context.lastIntent === 'greeting') &&
      (/\brm\s*\d/i.test(trimmed) || /budget|bajet|预算/i.test(message));
    if (looksLikeBudgetFirstMessage) {
      const budgetOnlyMatch =
        message.match(/\b(?:budget|bajet)[^0-9]{0,15}RM\s*([\d,]+)/i) ||
        message.match(/\bRM\s*([\d,]+)[^a-zA-Z0-9]{0,10}(?:budget|bajet|预算)\b/i) ||
        message.match(/\bRM\s*([\d,]+)/i) ||
        message.match(/(?:预算|budget|bajet)[^\d]*([\d,]+)/i);
      const budgetStr = budgetOnlyMatch ? (budgetOnlyMatch[1] || '').replace(/,/g, '').replace(/\s/g, '') : null;
      if (process.env.DEBUG === 'true') {
        console.log(
          `   [NLP] Budget-like first message detected; forcing bike_recommendation, budget=${budgetStr || 'unknown'}`,
        );
      }
      return {
        data: {
          intent: 'bike_recommendation',
          entities: budgetStr ? { budget: budgetStr } : {},
          language: context.language || 'english',
          confidence: 0.9,
          requires_product_search: true,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.9,
      };
    }

    // Special case: user replying "1/2/3" right after a no-results message.
    // In the no-results template, option 3 = contact team (human handoff).
    if (/^[1-3]\.?$/.test(trimmed) && context.lastIntent === 'no_results') {
      const num = parseInt(trimmed, 10);
      if (num === 3) {
        if (process.env.DEBUG === 'true') {
          console.log(`   [NLP] No-results flow: option 3 selected -> agent_request`);
        }
        return {
          data: {
            intent: 'agent_request',
            entities: {},
            language: context.language || 'english',
            confidence: 0.98,
            requires_product_search: false,
            requires_agent_escalation: true,
          },
          tokensUsed: 0,
          confidence: 0.98,
        };
      }
      // For options 1 and 2, let the normal clarification / search flow handle it
      // by falling through to the rest of the rules.
    }

    // Positive one-word replies like "想", "要", "ok", "yes" that depend on the previous bot question.
    // Example: bot asked "你想知道更多细节吗？" and user replies "想" -> intent should be "more_details".
    if (trimmed.length > 0 && trimmed.length <= 8) {
      const positiveReplies = new Set([
        'yes',
        'ok',
        'okay',
        'ya',
        'ya lah',
        'boleh',
        'baik',
        '是',
        '好',
        '想',
        '要',
        '准备好了',
        '好了',
        '我要',
        '我想要',
        'ready',
        'dah ready',
        '嗯',
        '可以',
      ]);
      const negativeReplies = new Set([
        'no',
        'nope',
        'tak',
        'tidak',
        'bukan',
        '不要',
        '不用',
        '不要了',
      ]);

      const isPositive = positiveReplies.has(lower) || positiveReplies.has(trimmed);
      const isNegative = negativeReplies.has(lower) || negativeReplies.has(trimmed);

      if (isPositive || isNegative) {
        const lastIntent = context.lastIntent || context.lastResult?.data?.intent;
        let followUpIntent = null;

        // If the last turn was a recommendation or a clarification about a product,
        // treat a positive reply as a request for more details.
        const lastBotAskedForDetails =
          typeof lastBotMessage === 'string' &&
          /more detail|full spec|maklumat lanjut|详细|更多细节|更多资料/i.test(lastBotMessage);

        if (isPositive && (lastIntent === 'bike_recommendation' || lastIntent === 'model_selection' || lastBotAskedForDetails)) {
          followUpIntent = 'more_details';
        } else if (isPositive && lastIntent) {
          // Generic: inherit last intent if we don't have a better guess.
          followUpIntent = lastIntent;
        } else if (isNegative && lastIntent === 'more_details') {
          // User declined more details; treat as a soft goodbye.
          followUpIntent = 'goodbye';
        }

        if (followUpIntent) {
          if (process.env.DEBUG === 'true') {
            console.log(
              `   [NLP] Short ${isPositive ? 'positive' : 'negative'} reply "${trimmed}" -> follow-up intent: ${followUpIntent}`,
            );
          }
          return {
            data: {
              intent: followUpIntent,
              entities: {},
              language: context.language || 'english',
              confidence: 0.9,
              requires_product_search: followUpIntent === 'more_details',
              requires_agent_escalation: false,
            },
            tokensUsed: 0,
            confidence: 0.9,
          };
        }
      }
    }

    // "got others?" / "show all models" -> more options
    if (
      /got others?|any others?|more options?|show more|other (bikes?|options?|suggestions?)|ada lain|还有别的|其他(的)?(选择|推荐)?/i.test(
        lower,
      ) ||
      /show (me )?all (the )?(bikes?|models?)/i.test(lower) ||
      /see all (the )?(bikes?|models?)/i.test(lower)
    ) {
      if (process.env.DEBUG === 'true') console.log(`   [NLP] More options detected: more_options`);
      return {
        data: {
          intent: 'more_options',
          entities: context.entities || context.metadata?.entities || {},
          language: context.language || 'english',
          confidence: 0.9,
          requires_product_search: true,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.9,
      };
    }

    // "got Honda?" / "got Yamaha" etc. -> treat as brand/model request
    const gotBrandMatch = lower.match(/^got\s+([a-z0-9][a-z0-9\s\-]+)/i);
    if (gotBrandMatch && gotBrandMatch[1]) {
      const brandOrModel = gotBrandMatch[1].replace(/[?.!]+$/g, '').trim();
      if (brandOrModel.length >= 2 && brandOrModel.length <= 40) {
        if (process.env.DEBUG === 'true') {
          console.log(`   [NLP] Brand/model request detected via "got X": ${brandOrModel}`);
        }
        return {
          data: {
            intent: 'bike_recommendation',
            entities: { brand: brandOrModel, model: brandOrModel },
            language: context.language || 'english',
            confidence: 0.9,
            requires_product_search: true,
            requires_agent_escalation: false,
          },
          tokensUsed: 0,
          confidence: 0.9,
        };
      }
    }

    // "arrange"/test ride
    const arrangeOrTestRide =
      /\barrange\b/i.test(lower) ||
      /arrange (a )?test ride|book (a )?test ride|test ride|ujian memandu|预约试驾|试驾/i.test(lower);
    if (arrangeOrTestRide && lower.length < 80) {
      if (process.env.DEBUG === 'true') console.log(`   [NLP] Arrange / test ride keyword -> test_ride_request`);
      return {
        data: {
          intent: 'test_ride_request',
          entities: {},
          language: context.language || 'english',
          confidence: 0.95,
          requires_product_search: false,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.95,
      };
    }

    // "I'm ready" / "准备好了" -> user confirms they are ready to proceed with test ride / booking.
    // This uses both explicit phrases and the previous bot message ("ready, tell us" pattern).
    const readyPhrases = [
      '我准备好了',
      '准备好了',
      '好了',
      "i am ready",
      "i'm ready",
      'im ready',
      'ready',
      'sedia',
      'dah ready',
      'dah sedia',
    ];
    const lastBotAskedReady =
      typeof lastBotMessage === 'string' &&
      /准备好就告诉|ready.*tell|sedia.*beritahu|book|预约|test.?ride|试驾/i.test(lastBotMessage);

    if (
      readyPhrases.some(p => lower.includes(p.toLowerCase())) ||
      (lastBotAskedReady && /ready|准备|好了|sedia/i.test(lower))
    ) {
      if (process.env.DEBUG === 'true') {
        console.log(`   [NLP] Ready confirmation detected -> test_ride_booking`);
      }
      return {
        data: {
          intent: 'test_ride_booking',
          entities: context.entities || {},
          language: context.language || 'english',
          confidence: 0.95,
          requires_product_search: false,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.95,
      };
    }

    // Direct agent keywords -> immediate agent_request (bypass LLM)
    const agentKeywords = /\bagent\b|客服|找客服|真人|人工|转人工/i;
    if (agentKeywords.test(lower)) {
      if (process.env.DEBUG === 'true') {
        console.log(`   [NLP] Agent keyword detected -> agent_request`);
      }
      return {
        data: {
          intent: 'agent_request',
          entities: {},
          language: context.language || 'english',
          confidence: 0.95,
          requires_product_search: false,
          requires_agent_escalation: true,
        },
        tokensUsed: 0,
        confidence: 0.95,
      };
    }

    // Configured escalation content words -> agent_request
    const agentNode = nodes.get('agent_escalation');
    const contentWords = (agentNode?.config?.content_words || [])
      .map(w => String(w).trim().toLowerCase())
      .filter(Boolean);
    if (contentWords.length > 0 && lower.length <= 80) {
      const matchesContentWord = contentWords.some(cw => lower === cw || lower.includes(cw));
      if (matchesContentWord) {
        if (process.env.DEBUG === 'true') console.log(`   [NLP] Content word matched -> agent_request (transfer to agent)`);
        return {
          data: {
            intent: 'agent_request',
            entities: {},
            language: context.language || 'english',
            confidence: 0.95,
            requires_product_search: false,
            requires_agent_escalation: true,
          },
          tokensUsed: 0,
          confidence: 0.95,
        };
      }
    }

    // "i want [model]" / "looking for [model]" etc. -> model_selection
    const extractedModel = this.extractModelNameFromMessage(message);
    const stopPhrases = /^(to |the |more |details?|price|info|about|how much|what is|test ride)/i;
    if (extractedModel.length >= 2 && extractedModel.length <= 60 && !/^\d+$/.test(extractedModel) && !stopPhrases.test(extractedModel)) {
      const looksLikeModelRequest =
        /^(i want|i'm looking for|looking for|do you have|got any|have you got|show me|can i see|would like)\s+/i.test(lower) ||
        (/^(ego s|yamaha|honda|modenas|suzuki|kawasaki|ninja|rxz|lc135|ego|nmax|aerox)/i.test(lower) &&
          lower.split(/\s+/).length <= 4);
      if (looksLikeModelRequest) {
        if (process.env.DEBUG === 'true') console.log(`   [NLP] Model lookup by name: "${extractedModel}"`);
        return {
          data: {
            intent: 'model_selection',
            entities: { model: extractedModel },
            language: context.language || 'english',
            confidence: 0.85,
            requires_product_search: false,
            requires_agent_escalation: false,
          },
          tokensUsed: 0,
          confidence: 0.85,
        };
      }
    }

    // User selected a model by number or name — prefer option ledger, then lastShownProducts
    const optionSets = context.optionSets || context.metadata?.optionSets;
    if (Array.isArray(optionSets) && optionSets.length > 0) {
      const trimmed = message.trim();
      const isNumericPick = /^[1-9]\d*\.?$/.test(trimmed);
      const isNamePick = trimmed.length > 1 && trimmed.length <= 80 && !trimmed.includes('?') && !isNumericPick;
      if (isNumericPick || isNamePick) {
        const resolved = resolveSelection({ optionSets }, trimmed);
        if (resolved) {
          if (process.env.DEBUG === 'true') {
            console.log(`   [NLP] Model selection via option ledger: ${resolved.item.stableId}`);
          }
          return {
            data: {
              intent: 'model_selection',
              entities: {
                selected_index: resolved.item.displayIndex,
                selected_id: resolved.item.stableId,
                selected_title: resolved.item.title,
                resolved_from_set: resolved.set.id,
              },
              language: context.language || 'english',
              confidence: 0.95,
              requires_product_search: false,
              requires_agent_escalation: false,
            },
            tokensUsed: 0,
            confidence: 0.95,
          };
        }
        if (isNumericPick) {
          return {
            data: {
              intent: 'clarify_selection',
              entities: {
                message:
                  'I have multiple lists — could you clarify which item ' +
                  trimmed +
                  ' you mean?',
              },
              language: context.language || 'english',
              confidence: 0.95,
              requires_product_search: false,
              requires_agent_escalation: false,
            },
            tokensUsed: 0,
            confidence: 0.95,
          };
        }
      }
    }

    const lastShown = context.lastShownProducts || context.metadata?.lastShownProducts;
    if (lastShown && Array.isArray(lastShown) && lastShown.length > 0) {
      const trimmed = message.trim();
      const num = parseInt(trimmed, 10);
      if (Number.isInteger(num) && num >= 1 && num <= lastShown.length) {
        if (process.env.DEBUG === 'true') console.log(`   [NLP] Model selection by number: ${num}`);
        return {
          data: {
            intent: 'model_selection',
            entities: { selected_index: num },
            language: context.language || 'english',
            confidence: 0.95,
            requires_product_search: false,
            requires_agent_escalation: false,
          },
          tokensUsed: 0,
          confidence: 0.95,
        };
      }
      const matchByName = lastShown.find(p =>
        (p.name && p.name.toLowerCase().includes(lower)) ||
        (p.brand && p.brand.toLowerCase().includes(lower)) ||
        (p.features?.model && String(p.features.model).toLowerCase().includes(lower))
      );
      if (matchByName && lower.length < 80) {
        if (process.env.DEBUG === 'true') console.log(`   [NLP] Model selection by name`);
        return {
          data: {
            intent: 'model_selection',
            entities: {},
            language: context.language || 'english',
            confidence: 0.9,
            requires_product_search: false,
            requires_agent_escalation: false,
          },
          tokensUsed: 0,
          confidence: 0.9,
        };
      }
    }

    // "more detail"
    if (/more detail|tell me more|full specs?|full details?|详细|maklumat lanjut/i.test(lower) && lower.length < 60) {
      if (process.env.DEBUG === 'true') console.log(`   [NLP] More details detected: more_details`);
      return {
        data: {
          intent: 'more_details',
          entities: {},
          language: context.language || 'english',
          confidence: 0.9,
          requires_product_search: false,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.9,
      };
    }

    // Structured "budget, area, model"
    const structured = this.parseStructuredBudgetAreaModel(message, context);
    if (structured) {
      if (process.env.DEBUG === 'true') {
        console.log(
          `   [NLP] Structured reply detected: bike_recommendation, budget=${structured.entities.budget}, area=${structured.entities.area}, model=${structured.entities.model}`,
        );
      }
      return {
        data: {
          intent: structured.intent,
          entities: structured.entities,
          language: structured.language,
          confidence: structured.confidence,
          requires_product_search: true,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: structured.confidence,
      };
    }

    // Budget-only messages like "I only have the budget of RM5,000"
    const budgetOnlyMatch =
      message.match(/\b(?:budget|bajet)[^0-9]{0,15}RM\s*([\d,]+)/i) ||
      message.match(/\bRM\s*([\d,]+)[^a-zA-Z0-9]{0,10}(?:budget|bajet)\b/i);
    if (budgetOnlyMatch) {
      const budgetStr = (budgetOnlyMatch[1] || '').replace(/,/g, '');
      if (budgetStr) {
        if (process.env.DEBUG === 'true') {
          console.log(`   [NLP] Budget-only message detected, budget=${budgetStr}`);
        }
        return {
          data: {
            intent: 'bike_recommendation',
            entities: {
              budget: budgetStr,
            },
            language: context.language || 'english',
            confidence: 0.9,
            requires_product_search: true,
            requires_agent_escalation: false,
          },
          tokensUsed: 0,
          confidence: 0.9,
        };
      }
    }

    // "但是我在X" / "i'm in X" / "i am at X" -> location refinement
    const locationMatch =
      message.match(
        /(?:我在|我住在|我是在|but i(?:'m| am) (?:in|at|from))\s*([a-zA-Z\u4e00-\u9fff][a-zA-Z\u4e00-\u9fff\s]{1,30})/i,
      ) ||
      message.match(
        /(?:i(?:'m| am) (?:in|at|from)|staying in|based in|located in)\s+([a-zA-Z][a-zA-Z\s]{1,30})/i,
      ) ||
      message.match(
        /(?:but|tapi|但是)?\s*(?:i(?:'m| am) in|我在|在)\s*([a-zA-Z\u4e00-\u9fff][a-zA-Z\u4e00-\u9fff\s]{1,20})/i,
      );

    if (locationMatch && locationMatch[1]) {
      const area = locationMatch[1].trim();
      const baseEntities =
        context.lastResult?.data?.entities ||
        context.entities ||
        context.metadata?.entities ||
        {};
      if (process.env.DEBUG === 'true') {
        console.log(`   [NLP] Location refinement detected: area=${area}`);
      }
      return {
        data: {
          intent: 'bike_recommendation',
          entities: {
            ...baseEntities, // keep existing budget/model/etc.
            area,
            location: area,
          },
          language: context.language || 'english',
          confidence: 0.92,
          requires_product_search: true,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.92,
      };
    }

    // Fallback: call OpenAI for structured extraction
    const baseLang = context.language || 'english';
    const systemPrompt =
      `You must respond ONLY in ${baseLang}. Never switch languages.\n\n` +
      (node.config.system_prompt ||
        'You are a sales assistant. Extract intent, language and entities from user messages. Always return JSON.');

    const historyPrefix = lastBotMessage
      ? `Previous assistant message: "${lastBotMessage}".\n\n`
      : '';
    const userPrompt = `${historyPrefix}Extract intent, language and entities from this user reply: "${message}"\n\nReturn JSON with: language (english/malay/chinese), intent, entities (object), confidence (0-1), requires_product_search (boolean), requires_agent_escalation (boolean)`;

    try {
      if (process.env.DEBUG === 'true') {
        console.log(`   [NLP] Processing message: "${message.substring(0, 50)}..."`);
      }

      // Language agent uses analyzer role config
      const { AI_ROLES, getRoleConfig } = await import('../config/ai-registry.js');
      const analyzerConfig = getRoleConfig(AI_ROLES.ANALYZER);
      const model = node.config.model || analyzerConfig.model;
      const temperature = node.config.temperature ?? analyzerConfig.temperature;
      const maxTokens = node.config.max_tokens || analyzerConfig.maxTokens;

      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      });

      const content = JSON.parse(completion.choices[0].message.content);
      const tokensUsed = completion.usage.total_tokens;

      const detectedLanguage = context.language || content.language || 'english';

      if (process.env.DEBUG === 'true') {
        console.log(
          `   [NLP] Language: ${detectedLanguage}, Intent: ${content.intent}, Confidence: ${content.confidence || 0.5}`,
        );
      }

      return {
        data: {
          intent: content.intent,
          entities: content.entities || {},
          // Never override existing conversation language with a new guess
          language: detectedLanguage,
          confidence: content.confidence || 0.5,
          requires_product_search: content.requires_product_search || false,
          requires_agent_escalation: content.requires_agent_escalation || false,
        },
        tokensUsed,
        confidence: content.confidence || 0.5,
      };
    } catch (error) {
      console.error('❌ NLP processing error:', error);
      console.error('   Error details:', error.message);
      if (error.response) {
        console.error('   API response:', error.response.data);
      }

      return {
        data: {
          intent: 'general_question',
          entities: {},
          language: 'english',
          confidence: 0.3,
          requires_product_search: false,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.3,
        error: error.message,
      };
    }
  }

  /**
   * Router: map intent to the next workflow node.
   */
  static handleRouter(node, context) {
    const intent = context.lastResult?.data?.intent;
    const route = node.config.routes.find(r => r.intent === intent);
    const entities = context.lastResult?.data?.entities;

    if (process.env.DEBUG === 'true') {
      console.log(
        `   [Router] Intent: ${intent}, Route found: ${!!route}, Next: ${route?.next || node.config.fallback}`,
      );
    }

    return {
      data: { intent, route, entities: entities || {} },
      tokensUsed: 0,
      next: route?.next || node.config.fallback,
    };
  }
}

export default LanguageAgent;

