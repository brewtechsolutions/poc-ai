import openai, { TOKEN_CONFIG } from '../config/openai.js';
import { AI_ROLES, getRoleConfig } from '../config/ai-registry.js';
import { getLatestEntitiesFromContext } from '../utils/entities.js';
import { productMatchesRequestedModel } from '../utils/products.js';

/**
 * ResponseAgent
 * Owns formatting, optimization, generic handlers and final action sending.
 * Keeps WorkflowEngine focused on orchestration.
 */
class ResponseAgent {
  /**
   * Remove parentheses around user-provided entity values.
   * This avoids needing per-node prompt hardcoding (works for any node that echoes entities).
   */
  static sanitizeUserValueParentheses(response, entities) {
    if (typeof response !== 'string' || !response) return response;

    const escapeRegExp = (s) =>
      String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const buildFlexibleValuePattern = (val) => {
      const parts = String(val)
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(escapeRegExp);
      return parts.join('\\s+');
    };

    const e = entities || {};
    const out = response;

    let result = out;

    // Budget is often formatted as "RM5000" / "RM 5,000" inside parentheses.
    const hasAnyBudget = !!(e.budget || e.budget_min || e.budget_max || e.price_range);
    if (hasAnyBudget) {
      // Remove parentheses that wrap RM numbers.
      result = result.replace(
        /[\(\（]\s*(RM\s*[0-9][0-9,\s]*)\s*[\)\）]/gi,
        '$1',
      );
    }

    // Exact value matches for non-budget fields.
    const valueKeys = ['area', 'location', 'model', 'brand'];
    for (const key of valueKeys) {
      const val = e[key];
      if (typeof val !== 'string') continue;
      const trimmed = val.trim();
      if (!trimmed) continue;

      const valuePattern = buildFlexibleValuePattern(trimmed);
      // Capture the matched inner text so we preserve original casing/spacing.
      const re = new RegExp(`[\\(（]\\s*(${valuePattern})\\s*[\\)）]`, 'gi');
      result = result.replace(re, '$1');
    }

    return result;
  }

  static resolveLanguage(context, workflow, nodeConfig = {}) {
    return (
      context.language ||
      context.metadata?.language ||
      nodeConfig.default_language ||
      workflow?.default_language ||
      workflow?.config?.default_language ||
      'english'
    );
  }


  /** Formatter nodes: build WhatsApp-friendly text from templates and products. */
  static handleFormatter(node, context, workflow) {
    const products = context.lastResult?.data?.products || [];
    const templateKey = node.config.template;
    const lastIntent = context.lastIntent || context.lastResult?.data?.intent;
    // Language is locked to context.language once chosen
    const language = this.resolveLanguage(context, workflow, node.config);
    const entities = getLatestEntitiesFromContext(context);
    const modelPart = (entities.model || '').trim();
    const brandPart = (entities.brand || '').trim();
    const requestedModel = !modelPart && !brandPart
      ? null
      : !modelPart
        ? brandPart
        : !brandPart
          ? modelPart
          : brandPart.toLowerCase() === modelPart.toLowerCase()
            ? modelPart
            : `${brandPart} ${modelPart}`.trim();

    let effectiveTemplateKey = templateKey;
    if (
      templateKey === 'bike_recommendation' &&
      requestedModel &&
      products.length > 0 &&
      lastIntent !== 'more_options'
    ) {
      const hasRequestedModel = products.some(p => productMatchesRequestedModel(p, requestedModel));
      if (!hasRequestedModel && workflow.templates.no_model_alternatives) {
        effectiveTemplateKey = 'no_model_alternatives';
      }
    }

    let template = '';
    if (typeof workflow.templates[effectiveTemplateKey] === 'object') {
      template =
        workflow.templates[effectiveTemplateKey][language] ||
        workflow.templates[effectiveTemplateKey].english ||
        '';
    } else {
      template = workflow.templates[effectiveTemplateKey] || '';
    }

    let formatted = template;
    if (effectiveTemplateKey === 'no_model_alternatives' && requestedModel) {
      formatted = formatted.replace(/\{model\}/g, requestedModel);
    }

    const recommendationReasoning = context.lastResult?.data?.recommendation_reasoning;
    formatted = formatted.replace(
      /\{recommendation_reasoning\}\n?\n?/g,
      recommendationReasoning ? `${recommendationReasoning}\n\n` : '\n',
    );

    if (products.length > 0) {
      const alternativeReasoning = context.lastResult?.data?.alternative_reasoning;
      const productsText = products
        .map((product, i) => {
          const features = product.features || {};
          const model = features.model || '';
          const nameOnly = (product.name || '').trim();
          const modelInName = model && nameOnly.toLowerCase().includes(model.toLowerCase());
          const title = model && !modelInName ? `${nameOnly} ${model}` : nameOnly;
          const engineSize = features.engineSize ? `${features.engineSize}cc` : '';
          const type = features.type || product.subcategory || '';
          const locations = features.locations ? ` (${features.locations.join(', ')})` : '';

          const details = [];
          if (engineSize) details.push(`Engine: ${engineSize}`);
          if (type) details.push(`Type: ${type}`);
          details.push(product.inStock ? '✅ In Stock' : '❌ Out of Stock');

          const block = [
            `${i + 1}. *${title}*`,
            `   ${product.description || 'No description'}`,
            `   Price: ${product.currency || 'MYR'} ${product.price?.toLocaleString() || product.price}${locations}`,
            `   ${details.join('\n   ')}`,
          ].join('\n');

          if (i === 1 && alternativeReasoning) {
            return `💡 ${alternativeReasoning}\n\n${block}`;
          }
          return block;
        })
        .join('\n\n');

      formatted = formatted.replace('{bikes}', productsText);
      formatted = formatted.replace('{products}', productsText);
    }

    if (node.config.include_context && context.lastResult?.data?.questions) {
      const questions = Array.isArray(context.lastResult.data.questions)
        ? context.lastResult.data.questions.join('\n')
        : context.lastResult.data.questions;
      formatted = formatted.replace('{questions}', questions);
    }

    if (node.config.include_context && context.lastResult?.data && typeof context.lastResult.data === 'object') {
      const data = context.lastResult.data;
      for (const [key, value] of Object.entries(data)) {
        if (value != null && key !== 'products' && key !== 'formatted' && key !== 'response') {
          const str =
            typeof value === 'string'
              ? value
              : Array.isArray(value)
                ? value.join('\n')
                : String(value);
          formatted = formatted.replace(new RegExp(`\\{${key}\\}`, 'g'), str);
        }
      }
    }

    if (products.length === 0 && (formatted.includes('{bikes}') || formatted.includes('{products}'))) {
      formatted = formatted.replace(/\{bikes\}\s*/g, '').replace(/\{products\}\s*/g, '').trim();
    }

    return {
      data: { formatted, products, response: formatted },
      tokensUsed: 0,
    };
  }

  /** Optimizer node: rewrite responses in a friendly WhatsApp tone. */
  static async handleOptimizer(node, context) {
    const prevData = context.lastResult?.data;
    let response =
      prevData?.formatted ||
      prevData?.response ||
      prevData?.finalResponse ||
      '';
    response = (response || '').toString().trim();

    const lastIntent = context.lastIntent || prevData?.intent;
    const isGreetingFlow = lastIntent === 'greeting' || prevData?.intent === 'greeting';

    // Product list responses carry numbering tied to optionSets.
    // Rewriting with LLM can change order/model names and desync user picks ("1","2","3").
    if (Array.isArray(prevData?.products) && prevData.products.length > 0) {
      const cleaned = response.replace(/\n{3,}/g, '\n\n').trim();
      if (process.env.DEBUG === 'true') {
        console.log('[Optimizer] Skipping LLM rewrite for product list response (preserve numbering fidelity)');
      }
      return {
        data: {
          optimized: cleaned,
          finalResponse: cleaned,
          products: prevData.products,
        },
        tokensUsed: 0,
      };
    }

    // Model details come from DB + ledger with exact product — do NOT send through LLM rewriter
    // (it often swaps or invents a different model name while "sounding friendly").
    if (prevData?.product && typeof response === 'string' && response.length > 0) {
      const cleaned = response.replace(/\n{3,}/g, '\n\n').trim();
      if (process.env.DEBUG === 'true') {
        console.log('[Optimizer] Skipping LLM rewrite for structured model_details (preserve product fidelity)');
      }
      return {
        data: {
          optimized: cleaned,
          finalResponse: cleaned,
          product: prevData.product,
        },
        tokensUsed: 0,
      };
    }

    // Only skip optimizer for greeting templates; allow it for language selection so it sounds human.
    if (!response || isGreetingFlow) {
      const cleaned = response.replace(/\n{3,}/g, '\n\n').trim();
      return {
        data: { optimized: cleaned, finalResponse: cleaned },
        tokensUsed: 0,
      };
    }

    const lockedLanguage = this.resolveLanguage(context, null, node.config);
    const fixedLanguagePolicy = [
      `MANDATORY LANGUAGE POLICY: Output ONLY in ${lockedLanguage}.`,
      `Never switch to another language even if the user message uses another language.`,
      `If needed, translate the content into ${lockedLanguage} while preserving meaning.`,
    ].join(' ');
    const basePrompt =
      node.config.system_prompt ||
      'You are a friendly sales assistant. Rewrite the reply to sound natural, clear and concise.';
    const systemPrompt =
      node.config.language_policy_prompt
        ? `${fixedLanguagePolicy}\n\n${node.config.language_policy_prompt}\n\n${basePrompt}`.trim()
        : `${fixedLanguagePolicy}\n\n${basePrompt}`.trim();

    try {
      // Get config from registry (can be overridden by node.config)
      const roleConfig = getRoleConfig(AI_ROLES.OPTIMIZER);
      const model = node.config.model || roleConfig.model;
      const temperature = node.config.temperature ?? roleConfig.temperature;
      const maxTokens = node.config.max_tokens || roleConfig.maxTokens;

      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: response },
        ],
        temperature,
        max_tokens: maxTokens,
      });

      const optimized = (completion.choices[0].message.content || '').trim();
      const tokensUsed = completion.usage?.total_tokens || 0;
      const finalText = optimized || response;

      return {
        data: { optimized: finalText, finalResponse: finalText },
        tokensUsed,
      };
    } catch (error) {
      console.error('[Optimizer] Error optimizing response:', error.message);
      let fallback = response.replace(/\n{3,}/g, '\n\n').trim();
      const estimatedTokens = Math.ceil(fallback.length / 4);
      const roleConfig = getRoleConfig(AI_ROLES.OPTIMIZER);
      const maxTokens = node.config.max_tokens || roleConfig.maxTokens;
      if (estimatedTokens > maxTokens) {
        fallback = `${fallback.substring(0, maxTokens * 4)}...`;
      }
      return {
        data: { optimized: fallback, finalResponse: fallback },
        tokensUsed: 0,
      };
    }
  }

  /** Generic handler nodes that just format templates. */
  static handleHandler(node, context, workflow) {
    const templateKey = node.config.template;
    // Always respect the conversation language once set
    const language = this.resolveLanguage(context, workflow, node.config);

    let template = '';
    if (typeof workflow.templates[templateKey] === 'object') {
      template =
        workflow.templates[templateKey][language] ||
        workflow.templates[templateKey].english ||
        '';
    } else {
      template = workflow.templates[templateKey] || '';
    }

    let response = template;
    if (node.config.include_context && context.lastResult?.data) {
      const data = context.lastResult.data;
      if (data.questions) {
        const questions = Array.isArray(data.questions) ? data.questions.join('\n') : data.questions;
        response = response.replace('{questions}', questions);
      }
    }

    if (process.env.DEBUG === 'true') {
      console.log(
        `   [Handler] Template: ${templateKey}, Language: ${language}, Response length: ${response.length}`,
      );
    }

    const previousFlags =
      (context.lastResult && context.lastResult.data && typeof context.lastResult.data === 'object')
        ? {
            // Preserve special control flags (e.g. needLanguageChoice) so optimizer can detect them
            ...(context.lastResult.data.needLanguageChoice ? { needLanguageChoice: true } : {}),
          }
        : {};

    return {
      data: {
        response,
        formatted: response,
        finalResponse: response,
        ...(templateKey === 'greeting' ? { intent: 'greeting' } : {}),
        ...previousFlags,
      },
      tokensUsed: 0,
    };
  }

  /** Final action node: choose the final text to send back. */
  static handleAction(node, context, workflow) {
    let response = null;

    const lastResult = context.lastResult?.data;
    if (lastResult) {
      response =
        lastResult.optimized ||
        lastResult.response ||
        lastResult.formatted ||
        lastResult.finalResponse;
    }

    if (!response && context.workflowSteps) {
      for (let i = context.workflowSteps.length - 1; i >= 0; i--) {
        const step = context.workflowSteps[i];
        const stepData = step.result?.data;
        if (stepData) {
          response =
            stepData.optimized ||
            stepData.response ||
            stepData.formatted ||
            stepData.finalResponse;
          if (response) break;
        }
      }
    }

    if (!response) {
      const allResults = context.allResults || [];
      for (let i = allResults.length - 1; i >= 0; i--) {
        const resultData = allResults[i]?.data;
        if (resultData) {
          response =
            resultData.optimized ||
            resultData.response ||
            resultData.formatted ||
            resultData.finalResponse;
          if (response) break;
        }
      }
    }

    if (!response) {
      const intent = context.lastResult?.data?.intent || 'greeting';
      // Final fallback also sticks to the previously selected conversation language
      const language = this.resolveLanguage(context, workflow, node.config);
      const templateKey = intent === 'greeting' ? 'greeting' : `${intent}_response`;
      let template = '';

      if (typeof workflow.templates[templateKey] === 'object') {
        template =
          workflow.templates[templateKey][language] ||
          workflow.templates[templateKey].english ||
          '';
      } else {
        template = workflow.templates[templateKey] || '';
      }

      if (!template && typeof workflow.templates.greeting === 'object') {
        template =
          workflow.templates.greeting[language] ||
          workflow.templates.greeting.english ||
          '';
      } else if (!template) {
        template = workflow.templates.greeting || '';
      }

      if (!template && typeof workflow.templates?.error_fallback === 'object') {
        template =
          workflow.templates.error_fallback[language] ||
          workflow.templates.error_fallback.english ||
          '';
      } else if (!template && workflow.templates?.error_fallback) {
        template = workflow.templates.error_fallback;
      }

      response =
        template ||
        node.config.fallback_response ||
        "I apologize, I couldn't process that request. Please try rephrasing your question.";
    }

    // Generic safety: strip parentheses around user-provided entity values
    // (budget/area/location/model/brand) so user echoes don't show as "(RM5000)".
    response = this.sanitizeUserValueParentheses(
      response,
      context.entities || context.lastResult?.data?.entities || {},
    );

    if (process.env.DEBUG === 'true') {
      console.log(`[Action] Final response: ${response?.substring(0, 100)}...`);
      console.log(`[Action] Response source: ${response ? 'found' : 'NOT FOUND'}`);
      console.log(
        `[Action] Last result keys:`,
        context.lastResult?.data ? Object.keys(context.lastResult.data) : 'none',
      );
    }

    return {
      data: { finalResponse: response },
      tokensUsed: 0,
    };
  }
}

export default ResponseAgent;

