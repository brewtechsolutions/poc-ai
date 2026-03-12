import openai, { TOKEN_CONFIG } from '../config/openai.js';
import prisma from '../config/database.js';
import ProductRecommender from '../utils/product-recommender.js';

/**
 * SearchAgent - handles product search, ranking and related ML nodes
 * This keeps WorkflowEngine focused on orchestration while this module
 * encapsulates the multi-step "find and rank bikes" behaviour.
 */
class SearchAgent {
  static canHandle(node) {
    return [
      'context_collector',
      'product_recommender',
      'bike_ranker',
      'no_results_handler',
    ].includes(node.id) || (
      node.type === 'database' && node.config?.operation === 'semantic_search'
    );
  }

  /**
   * Entry point used when you want to treat this as a generic agent.
   * (Not yet wired into WorkflowEngine, but available for future use.)
   */
  static async execute(node, context, { workflow }) {
    const lastResult = context.lastResult?.data;

    if (node.type === 'database' && node.config?.operation === 'semantic_search') {
      return this.semanticProductSearch(node, context, lastResult);
    }

    if (node.type === 'ml') {
      return this.handleML(node, context, workflow);
    }

    return { data: context.lastResult?.data, tokensUsed: 0 };
  }

  /**
   * Database-level semantic product search (bike_search node).
   * This is migrated from WorkflowEngine.semanticProductSearch.
   */
  static async semanticProductSearch(node, context, lastResult) {
    const query = context.user_message || '';
    const entities = lastResult?.entities || context.entities || context.metadata?.entities || {};
    const category = node.config.category || entities.category || null;
    const isMoreOptions = context.lastIntent === 'more_options';

    const modelSearchText = (entities.model || entities.brand || '').toString().trim();
    const hasRequestedModel = !isMoreOptions && modelSearchText.length > 0;
    const primarySearchText = modelSearchText || query;
    const searchTerms = primarySearchText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const budgetNum = entities.budget ? parseFloat(entities.budget) : null;

    const limit = isMoreOptions
      ? (node.config.more_options_limit || 10)
      : (node.config.limit || 15);

    let finalProducts = [];

    if (hasRequestedModel) {
      const modelOnlyConditions = {
        AND: [
          { active: true },
          { inStock: true },
          {
            OR: [
              { name: { contains: primarySearchText, mode: 'insensitive' } },
              { brand: { contains: primarySearchText, mode: 'insensitive' } },
              { subcategory: { contains: entities.type || primarySearchText, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
              { category: { contains: category || query, mode: 'insensitive' } },
              { tags: { hasSome: searchTerms } },
            ],
          },
        ],
      };

      const modelMatches = await prisma.product.findMany({
        where: modelOnlyConditions,
        take: limit,
        orderBy: { popularity: 'desc' },
      });

      let afterBudget = modelMatches;
      if (budgetNum != null) {
        afterBudget = modelMatches.filter(p => p.price <= budgetNum);
      }

      let afterArea = afterBudget;
      if (entities.area) {
        afterArea = afterBudget.filter(p => {
          const locations = p.features?.locations || [];
          return locations.length === 0 || locations.some(loc =>
            loc.toLowerCase().includes(entities.area.toLowerCase())
          );
        });
        if (afterArea.length === 0) afterArea = afterBudget;
      }

      if (modelMatches.length > 0) {
        const modelIds = new Set(modelMatches.map(p => p.id));
        const inBudgetAndArea = afterArea.filter(p => modelIds.has(p.id));
        finalProducts = [...inBudgetAndArea, ...modelMatches.filter(p => !inBudgetAndArea.find(m => m.id === p.id))];

        const modelIsPricey = budgetNum != null && inBudgetAndArea.length === 0;
        if (modelIsPricey) {
          const altConditions = {
            AND: [
              { active: true },
              { inStock: true },
              { price: { lte: budgetNum } },
              { id: { notIn: [...modelIds] } },
            ],
          };
          const alternatives = await prisma.product.findMany({
            where: altConditions,
            take: 10,
            orderBy: { popularity: 'desc' },
          });
          let altFiltered = alternatives;
          if (entities.area) {
            altFiltered = alternatives.filter(p => {
              const locations = p.features?.locations || [];
              return locations.length === 0 || locations.some(loc =>
                loc.toLowerCase().includes(entities.area.toLowerCase())
              );
            });
            if (altFiltered.length === 0) altFiltered = alternatives;
          }
          finalProducts = [...finalProducts, ...altFiltered.slice(0, 1)];
        } else {
          const altConditions = {
            AND: [
              { active: true },
              { inStock: true },
              { id: { notIn: [...modelIds] } },
            ],
          };
          if (budgetNum != null) altConditions.AND.push({ price: { lte: budgetNum } });
          const alternatives = await prisma.product.findMany({
            where: altConditions,
            take: 10,
            orderBy: { popularity: 'desc' },
          });
          let altFiltered = alternatives;
          if (entities.area) {
            altFiltered = alternatives.filter(p => {
              const locations = p.features?.locations || [];
              return locations.length === 0 || locations.some(loc =>
                loc.toLowerCase().includes(entities.area.toLowerCase())
              );
            });
            if (altFiltered.length === 0) altFiltered = alternatives;
          }
          finalProducts = [...finalProducts, ...altFiltered.slice(0, 1)];
        }
        finalProducts = finalProducts.slice(0, 4);
      } else {
        const modelWords = primarySearchText.split(/\s+/).filter(w => w.length >= 2).map(w => w.trim());
        if (modelWords.length > 0) {
          const orConditions = [];
          for (const word of modelWords) {
            orConditions.push({ name: { contains: word, mode: 'insensitive' } });
            orConditions.push({ brand: { contains: word, mode: 'insensitive' } });
            orConditions.push({ description: { contains: word, mode: 'insensitive' } });
          }
          const nearMatchConditions = {
            AND: [
              { active: true },
              { inStock: true },
              { OR: orConditions },
            ],
          };
          const nearMatches = await prisma.product.findMany({
            where: nearMatchConditions,
            take: limit,
            orderBy: { popularity: 'desc' },
          });
          let nearFiltered = nearMatches;
          if (budgetNum != null) {
            nearFiltered = nearMatches.filter(p => p.price <= budgetNum);
            if (nearFiltered.length === 0) nearFiltered = nearMatches;
          }
          if (entities.area) {
            const byArea = nearFiltered.filter(p => {
              const locations = p.features?.locations || [];
              return locations.length === 0 || locations.some(loc =>
                loc.toLowerCase().includes(entities.area.toLowerCase())
              );
            });
            if (byArea.length > 0) nearFiltered = byArea;
          }
          finalProducts = nearFiltered.slice(0, 4);
        }
      }
    }

    if (!hasRequestedModel || finalProducts.length === 0) {
      const baseConditions = {
        AND: [
          { active: true },
          { inStock: true },
        ],
      };

      if (!isMoreOptions) {
        baseConditions.AND.push({
          OR: [
            { name: { contains: primarySearchText, mode: 'insensitive' } },
            { brand: { contains: primarySearchText, mode: 'insensitive' } },
            { subcategory: { contains: entities.type || primarySearchText, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
            { category: { contains: category || query, mode: 'insensitive' } },
            { tags: { hasSome: searchTerms } },
          ],
        });
      }

      if (!isMoreOptions && budgetNum != null) {
        baseConditions.AND.push({ price: { lte: budgetNum } });
      }

      const products = await prisma.product.findMany({
        where: baseConditions,
        take: limit,
        orderBy: { popularity: 'desc' },
      });

      let filteredProducts = products;
      if (entities.area) {
        filteredProducts = products.filter(p => {
          const locations = p.features?.locations || [];
          return locations.length === 0 || locations.some(loc =>
            loc.toLowerCase().includes(entities.area.toLowerCase())
          );
        });
        if (filteredProducts.length === 0) filteredProducts = products;
      }

      if (hasRequestedModel && finalProducts.length === 0) {
        finalProducts = filteredProducts.slice(0, 1);
      } else if (!hasRequestedModel) {
        finalProducts = filteredProducts;
      }
    }

    const useFallbackWhenEmpty = node.config.use_fallback_when_empty === true;
    if ((!finalProducts || finalProducts.length === 0) && useFallbackWhenEmpty) {
      const fallbackLimit = node.config.fallback_limit || 5;
      const fallbackProducts = await prisma.product.findMany({
        where: { active: true, inStock: true },
        orderBy: { popularity: 'desc' },
        take: fallbackLimit,
      });
      finalProducts = fallbackProducts;
    }

    return {
      data: { products: finalProducts || [] },
      tokensUsed: 0,
      found: (finalProducts && finalProducts.length) > 0,
    };
  }

  /**
   * Handle ML nodes related to search / recommendation.
   * This is adapted from WorkflowEngine.handleML for specific node IDs.
   */
  static async handleML(node, context, workflow) {
    const lastResult = context.lastResult?.data;
    const products = lastResult?.products || [];
    const userQuery = context.user_message;

    if (node.id === 'context_collector') {
      // Merge entities across turns: previous session context + latest NLP entities
      const mergedEntities = this.getEntitiesFromContext(context);
      const hasBudget = !!(
        mergedEntities.budget ||
        mergedEntities.price_range ||
        context.metadata?.budget
      );
      const hasArea = !!(mergedEntities.area || mergedEntities.location);

      // UX: if user already gave a budget, we treat it as "good enough"
      // to show recommendations first, then ask for area/preferences later.
      const contextComplete = hasBudget || (hasBudget && hasArea);
      const recommendationMode = hasBudget && !hasArea ? 'budget_only' : 'full';

      if (process.env.DEBUG === 'true') {
        console.log(
          `   [ML/context_collector] contextComplete=${contextComplete}, hasBudget=${hasBudget}, hasArea=${hasArea}, mode=${recommendationMode}`,
        );
      }

      // Persist merged entities back into context for downstream nodes
      context.entities = mergedEntities;

      return {
        data: {
          ...lastResult,
          entities: mergedEntities,
          contextComplete,
          recommendationMode,
        },
        tokensUsed: 0,
        confidence: contextComplete ? 0.95 : 0.5,
      };
    }

    if (node.id === 'product_recommender') {
      const recommendation = await ProductRecommender.recommend(userQuery, {
        preferences: context.userPreferences,
      });

      return {
        data: {
          products: recommendation.products,
          reasoning: recommendation.reasoning,
          fallbackProducts: recommendation.fallbackProducts,
        },
        tokensUsed: recommendation.tokensUsed || 0,
        confidence: recommendation.confidence,
      };
    }

    if (node.id === 'bike_ranker' || node.id === 'product_ranker') {
      if (products.length === 0) {
        return {
          data: { products: [], reasoning: 'No products found' },
          tokensUsed: 0,
          confidence: 0,
          next: 'no_results_handler',
        };
      }

      const entities = this.getEntitiesFromContext(context);
      const requestedModel = (entities.model || entities.brand || '').toString().trim();
      const isMoreOptions = context.lastIntent === 'more_options';

      if (isMoreOptions) {
        const topN = node.config.top_n || 5;
        const moreProducts = products.slice(0, topN);
        if (process.env.DEBUG === 'true') console.log(`   [bike_ranker] more_options: returning ${moreProducts.length} additional options (no model-first framing)`);
        return {
          data: {
            products: moreProducts,
            recommendation_reasoning: '',
            alternative_reasoning: '',
            reasoning: 'More options within your criteria.',
          },
          tokensUsed: 0,
          confidence: 0.9,
        };
      }

      if (requestedModel) {
        const modelMatches = products.filter(p => this.productMatchesRequestedModel(p, requestedModel));
        const alternatives = products.filter(p => !this.productMatchesRequestedModel(p, requestedModel));
        const altCount = modelMatches.length > 0 ? 1 : 4;
        const ordered = [...modelMatches, ...alternatives.slice(0, altCount)];
        if (process.env.DEBUG === 'true') {
          console.log(`   [bike_ranker] Requested model: "${requestedModel}", model matches: ${modelMatches.length}, alternatives: ${ordered.length} (${modelMatches.length > 0 ? '1 alt' : 'near matches only'})`);
        }

        let recommendationReasoning = '';
        let alternativeReasoning = '';
        let reasoningTokensUsed = 0;
        if (ordered.length > 0) {
          if (modelMatches.length === 0) {
            const lang = context.language || 'english';
            if (lang === 'malay') recommendationReasoning = 'Kami tidak ada model tersebut; berikut pilihan yang hampir sama atau jenama yang sama.';
            else if (lang === 'chinese') recommendationReasoning = '我们没有该型号；以下是相近或同品牌的选择。';
            else recommendationReasoning = 'We don\'t have that exact model; here are similar or same-brand options that might suit you.';
          } else {
            try {
              const lang = context.language || entities.language || 'english';
              const budgetStr = entities.budget ? `RM ${entities.budget}` : 'your budget';
              const firstBike = ordered[0];
              const firstPrice = firstBike.price != null ? `MYR ${Number(firstBike.price).toLocaleString()}` : '';
              const secondBike = ordered[1];
              const systemPrompt = 'You are a friendly motorcycle sales assistant. Return JSON with two short sentences in the user\'s language (English, Malay, or Chinese): model_reasoning = why the first bike is shown (they asked for this model but it may be a bit above budget). alternative_reasoning = why the second bike is recommended (e.g. fits their budget and is available in their area). Keep each 1 sentence, warm and helpful.';
              const userPrompt = `User's budget: ${budgetStr}. Area: ${entities.area || 'any'}. They asked for: ${requestedModel}. First bike: ${firstBike.name} (${firstPrice}). Second bike: ${secondBike ? secondBike.name + ' (MYR ' + Number(secondBike.price).toLocaleString() + ')' : 'none'}. Language: ${lang}. Return JSON: { "model_reasoning": "...", "alternative_reasoning": "..." }`;
              const completion = await openai.chat.completions.create({
                model: node.config.model || 'gpt-4o-mini',
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt },
                ],
                temperature: 0.3,
                max_tokens: 150,
                response_format: { type: 'json_object' },
              });
              reasoningTokensUsed = completion.usage?.total_tokens || 0;
              const parsed = JSON.parse(completion.choices[0].message.content || '{}');
              recommendationReasoning = (parsed.model_reasoning || '').trim();
              alternativeReasoning = (parsed.alternative_reasoning || '').trim();
            } catch (err) {
              if (process.env.DEBUG === 'true') console.log('   [bike_ranker] Reasoning fallback:', err.message);
              const lang = context.language || 'english';
              if (lang === 'malay') {
                recommendationReasoning = 'Berdasarkan model pilihan anda, saya jumpa padanan — harganya sedikit melebihi bajet.';
                alternativeReasoning = 'Pilihan ini sesuai dengan bajet dan lokasi anda.';
              } else if (lang === 'chinese') {
                recommendationReasoning = '根据您选的型号我找到了匹配，但价格略超预算。';
                alternativeReasoning = '下面这款在您预算内且您所在地区有货。';
              } else {
                recommendationReasoning = 'Based on your preferred model I found a match — it\'s a bit above your budget.';
                alternativeReasoning = 'The option below fits your budget and is available in your area.';
              }
            }
          }
        }

        return {
          data: {
            products: ordered,
            recommendation_reasoning: recommendationReasoning,
            alternative_reasoning: alternativeReasoning,
            reasoning: modelMatches.length > 0
              ? 'Showing your preferred model first, plus one alternative within your budget and area.'
              : 'We don\'t have that model in stock; here\'s one option that fits your budget and location.',
          },
          tokensUsed: reasoningTokensUsed,
          confidence: 0.9,
        };
      }

      const systemPrompt = node.config.system_prompt ||
        'Rank products by relevance to user\'s requirements. Consider: budget match, area availability, model preference, specifications, user intent.';
      const productsList = products.map((p, i) => {
        const features = p.features || {};
        const model = features.model || '';
        const engineSize = features.engineSize ? `${features.engineSize}cc` : '';
        const type = features.type || p.subcategory || '';
        const locations = features.locations ? `, Available in: ${features.locations.join(', ')}` : '';
        return `${i + 1}. ${p.name}${model ? ` ${model}` : ''} - ${p.currency || 'MYR'} ${p.price?.toLocaleString() || p.price}${engineSize ? `, ${engineSize}` : ''}${type ? `, ${type}` : ''}${locations}`;
      }).join('\n');

      const userPrompt = `User query: "${userQuery}"
User requirements: Budget: ${entities.budget || 'Not specified'}, Area: ${entities.area || 'Not specified'}, Model: ${entities.model || 'Not specified'}

Available products:
${productsList}

Rank products by relevance. Return JSON with: products (array with id/name, relevance_score, reasoning), overall_reasoning, confidence.`;

      try {
        const completion = await openai.chat.completions.create({
          model: node.config.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: node.config.temperature || 0.2,
          max_tokens: node.config.max_tokens || 400,
          response_format: { type: 'json_object' },
        });

        const content = JSON.parse(completion.choices[0].message.content);
        const tokensUsed = completion.usage.total_tokens;

        const topN = node.config.top_n || 5;
        const normalize = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        let rankedProducts = (content.products || []).map(ranked => {
          const name = (ranked.name || ranked.id || '').toString();
          const product = products.find(p =>
            p.id === ranked.id ||
            p.name === ranked.name ||
            normalize(p.name).includes(normalize(name)) ||
            normalize(name).includes(normalize(p.name)) ||
            `${p.brand} ${p.features?.model || ''}`.trim() === name
          );
          if (!product) return null;
          return {
            ...product,
            relevance_score: ranked.relevance_score ?? 0.5,
            reasoning: ranked.reasoning || 'Relevant product',
          };
        }).filter(Boolean).sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
          .slice(0, topN);

        if (rankedProducts.length === 0 && products.length > 0) {
          rankedProducts = products.slice(0, topN).map(p => ({
            ...p,
            relevance_score: 0.7,
            reasoning: 'Matches your search',
          }));
        }

        return {
          data: {
            products: rankedProducts,
            reasoning: content.overall_reasoning || content.reasoning,
          },
          tokensUsed,
          confidence: content.confidence || 0.7,
        };
      } catch (error) {
        console.error('Product ranking error:', error);
        return {
          data: {
            products: products.slice(0, node.config.top_n || 5),
            reasoning: 'Fallback ranking by popularity',
          },
          tokensUsed: 0,
          confidence: 0.5,
        };
      }
    }

    if (node.config.system_prompt && node.config.next) {
      try {
        const systemPrompt = node.config.system_prompt;
        let userContent = typeof userQuery === 'string' ? userQuery : String(context.user_message || '');
        if (node.id === 'no_results_handler' && lastResult) {
          const searchInfo = lastResult.entities || context.metadata?.entities || {};
          userContent = `User's search had no results. They asked for: budget=${searchInfo.budget || 'any'}, area=${searchInfo.area || 'any'}, model=${searchInfo.model || 'any'}. User message: "${userContent}"`;
        }
        const completion = await openai.chat.completions.create({
          model: node.config.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: node.config.temperature ?? 0.3,
          max_tokens: node.config.max_tokens || 200,
          response_format: { type: 'json_object' },
        });
        const content = JSON.parse(completion.choices[0].message.content);
        const tokensUsed = completion.usage?.total_tokens || 0;

        // Tag no_results_handler responses so NLP can treat following "1/2/3" correctly
        const data =
          node.id === 'no_results_handler'
            ? { ...content, intent: 'no_results' }
            : { ...content };

        return {
          data,
          tokensUsed,
          confidence: content.confidence ?? 0.8,
        };
      } catch (err) {
        console.error('ML node error (', node.id, '):', err.message);
        const fallback =
          node.id === 'no_results_handler'
            ? {
                message:
                  "Sorry, we don't have that right now. Would you like to try a different budget or area?",
                intent: 'no_results',
              }
            : {
                clarification_message:
                  "To recommend the best bikes, please share your budget (e.g. RM 5,000), area (e.g. Puchong), and preferred model if any.",
              };

        return {
          data: fallback,
          tokensUsed: 0,
          confidence: 0.3,
        };
      }
    }

    return {
      data: { products: [], reasoning: 'No results' },
      tokensUsed: 0,
      confidence: 0,
    };
  }

  /** Get entities from most recent result in context (local copy). */
  static getEntitiesFromContext(context) {
    const results = context.allResults || [];
    let latestEntities = null;
    for (let i = results.length - 1; i >= 0; i--) {
      const entities = results[i]?.data?.entities;
      if (entities && typeof entities === 'object' && Object.keys(entities).length > 0) {
        latestEntities = entities;
        break;
      }
    }

    const base =
      context.entities ||
      context.metadata?.entities ||
      context.lastResult?.data?.entities ||
      {};

    // Merge new entities (from latest NLP/search step) on top of existing ones
    return latestEntities ? { ...base, ...latestEntities } : base;
  }

  /** Local helper to match a product against a requested model/brand. */
  static productMatchesRequestedModel(product, requestedModel) {
    if (!requestedModel || typeof requestedModel !== 'string') return true;
    const n = (s) => (s || '').toLowerCase().trim();
    const key = n(requestedModel);
    const name = n(product.name);
    const brand = n(product.brand || '');
    const model = n(product.features?.model || '');
    return name.includes(key) || (brand + ' ' + model).trim().includes(key) || model.includes(key);
  }
}

export default SearchAgent;

