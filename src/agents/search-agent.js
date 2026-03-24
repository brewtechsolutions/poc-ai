import openai, { TOKEN_CONFIG } from '../config/openai.js';
import { AI_ROLES, getRoleConfig } from '../config/ai-registry.js';
import prisma from '../config/database.js';
import ProductRecommender from '../utils/product-recommender.js';
import { getMergedEntitiesFromContext } from '../utils/entities.js';
import { productMatchesRequestedModel } from '../utils/products.js';

/**
 * Extract brand from user message (generic - works for any product domain).
 * Brands are now looked up dynamically from the database, not hardcoded.
 */

/** Hard cap for "slightly over budget" (budget + 999). Adjust to fit inventory spread. */
const BUDGET_OVER_CAP = 999;

/**
 * Extract budget from message. Three patterns to cover common Malaysian budget phrases.
 * Handles: RM5000, MYR 5,000, budget of RM5000, i have the budget of RM5000, my budget is 5000, 5000rm, 5000 ringgit.
 * @returns {number|null} Budget amount or null
 */
function extractBudgetFromMessage(message) {
  if (!message || typeof message !== 'string') return null;
  const cleaned = message.toLowerCase().trim();

  // Pattern 1: RM/MYR directly before number → "RM5000", "MYR 5,000"
  const prefixMatch = cleaned.match(/(?:rm|myr)\s?(\d[\d,]*)/);
  if (prefixMatch) {
    const num = parseInt(prefixMatch[1].replace(/,/g, ''), 10);
    return Number.isNaN(num) ? null : num;
  }

  // Pattern 2: number followed by RM/MYR/ringgit → "5000rm", "5000 ringgit"
  const suffixMatch = cleaned.match(/(\d[\d,]*)\s?(?:rm|myr|ringgit)/);
  if (suffixMatch) {
    const num = parseInt(suffixMatch[1].replace(/,/g, ''), 10);
    return Number.isNaN(num) ? null : num;
  }

  // Pattern 3: "budget" keyword near a number → "budget of 5000", "my budget is rm5000", "budget of RM5000"
  const budgetMatch = cleaned.match(/budget[^0-9]*(\d[\d,]*)/);
  if (budgetMatch) {
    const num = parseInt(budgetMatch[1].replace(/,/g, ''), 10);
    return Number.isNaN(num) ? null : num;
  }

  return null;
}

/**
 * Extract brand from user message (generic - works for any product domain).
 * Uses database lookup to find matching brands dynamically.
 * @returns {Promise<string|null>} Normalized brand name (title case for display) or null
 */
async function extractBrandFromMessage(message) {
  if (!message || typeof message !== 'string') return null;
  const lower = message.toLowerCase().trim();
  
  // Get all available brands from database
  const availableBrands = await getAvailableBrandsFromDb();
  const found = availableBrands.find(b => lower.includes(b.toLowerCase()));
  return found || null;
}

/**
 * Get list of brands that exist in inventory (active, in stock).
 * @returns {Promise<string[]>} Sorted array of brand names
 */
async function getAvailableBrandsFromDb() {
  const rows = await prisma.product.findMany({
    where: { active: true, inStock: true, brand: { not: null } },
    select: { brand: true },
  });
  const brands = [...new Set(rows.map(r => r.brand).filter(Boolean))].sort();
  return brands;
}

/**
 * SearchAgent - Generic product search, ranking and related ML nodes
 * This keeps WorkflowEngine focused on orchestration while this module
 * encapsulates the multi-step "find and rank products" behavior.
 * Works for any product domain (motorcycles, electronics, etc.)
 */
class SearchAgent {
  static canHandle(node) {
    return [
      'context_collector',
      'product_recommender',
      'bike_ranker',
      'product_ranker',
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
   * Generic product search - works for any product domain.
   * Category and filters are driven by node.config, not hardcoded.
   */
  static async semanticProductSearch(node, context, lastResult) {
    const query = context.user_message || '';
    const entities = lastResult?.entities || context.entities || context.metadata?.entities || {};
    // Get category from config (e.g. "Motorcycle" for MotorShop, "Electronics" for electronics shop)
    const category = node.config.category || entities.category || null;
    const isMoreOptions = context.lastIntent === 'more_options';
    const skipIds = context.skipAlreadyShownIds || [];
    const limit = isMoreOptions
      ? (node.config.more_options_limit || 10)
      : (node.config.limit || 15);
    try {
      const searchType = context.searchType || lastResult?.searchType || null;
      const isBudgetOnly = searchType === 'budget_only';

    // Brand-availability check: if user asks for a specific brand only, query DB first.
    // Skip this in budget_only mode.
    if (!isBudgetOnly) {
      const brandFromMessage = await extractBrandFromMessage(query);
      const brandFromEntities = (entities.brand || '').toString().trim();
      const requestedBrandOnly = (brandFromMessage || brandFromEntities) && !(entities.model || '').toString().trim();
      const brandToCheck = (brandFromMessage || brandFromEntities || '').toLowerCase();
      if (requestedBrandOnly && brandToCheck && !isMoreOptions) {
        const brandProducts = await prisma.product.findMany({
          where: {
            active: true,
            inStock: true,
            brand: { equals: brandToCheck, mode: 'insensitive' },
          },
          take: limit,
          orderBy: { popularity: 'desc' },
        });
        if (brandProducts.length > 0) {
          const displayBrand = brandFromMessage || brandFromEntities;
          return {
            data: {
              products: brandProducts,
              brandRequested: displayBrand,
            },
            tokensUsed: 0,
            found: true,
          };
        }
        // Brand requested but not in inventory — return special payload so we don't recommend other brands
        const availableBrands = await getAvailableBrandsFromDb();
        const displayBrand = brandFromMessage || (brandFromEntities || brandToCheck).charAt(0).toUpperCase() + brandToCheck.slice(1);
        if (process.env.DEBUG === 'true') {
          console.log(`   [product_search] Brand "${displayBrand}" not in inventory. Available: ${availableBrands.join(', ')}`);
        }
        return {
          data: {
            products: [],
            found: false,
            brandUnavailable: true,
            brandRequested: displayBrand,
            availableBrands,
          },
          tokensUsed: 0,
          found: false,
        };
      }
    }

    const modelSearchText = (entities.model || entities.brand || '').toString().trim();
    const hasRequestedModel = !isMoreOptions && !isBudgetOnly && modelSearchText.length > 0;
    const primarySearchText = modelSearchText || query;
    const searchTerms = primarySearchText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const rawBudget = entities.budget ? String(entities.budget).replace(/,/g, '') : null;
    const budgetNum = rawBudget ? parseFloat(rawBudget) : extractBudgetFromMessage(query);
    const budgetCap = budgetNum != null ? budgetNum + BUDGET_OVER_CAP : null;
    if (process.env.DEBUG === 'true' && budgetNum != null) {
      console.log('[Budget Extracted]', budgetNum, rawBudget ? '(from entities)' : '(from message)');
    }

    let finalProducts = [];

    if (hasRequestedModel) {
      const modelOnlyConditions = {
        AND: [
          { active: true },
          { inStock: true },
          ...(skipIds.length > 0 ? [{ id: { notIn: skipIds } }] : []),
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
      if (budgetCap != null) {
        afterBudget = modelMatches.filter(p => p.price != null && p.price <= budgetCap);
        if (afterBudget.length === 0) afterBudget = modelMatches;
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
        const inBudgetAndAreaIds = new Set(inBudgetAndArea.map(p => p.id));
        finalProducts = [...inBudgetAndArea, ...modelMatches.filter(p => !inBudgetAndAreaIds.has(p.id))];

        const modelIsPricey = budgetNum != null && inBudgetAndArea.length === 0;
        if (modelIsPricey) {
          const altConditions = {
            AND: [
              { active: true },
              { inStock: true },
              ...(skipIds.length > 0 ? [{ id: { notIn: skipIds } }] : []),
              ...(budgetCap != null ? [{ price: { lte: budgetCap } }] : []),
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
              ...(skipIds.length > 0 ? [{ id: { notIn: skipIds } }] : []),
              { id: { notIn: [...modelIds] } },
            ],
          };
          if (budgetCap != null) altConditions.AND.push({ price: { lte: budgetCap } });
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
              ...(skipIds.length > 0 ? [{ id: { notIn: skipIds } }] : []),
              { OR: orConditions },
            ],
          };
          const nearMatches = await prisma.product.findMany({
            where: nearMatchConditions,
            take: limit,
            orderBy: { popularity: 'desc' },
          });
          let nearFiltered = nearMatches;
          if (budgetCap != null) {
            nearFiltered = nearMatches.filter(p => p.price != null && p.price <= budgetCap);
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
          ...(skipIds.length > 0 ? [{ id: { notIn: skipIds } }] : []),
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

      if (!isMoreOptions && budgetCap != null) {
        baseConditions.AND.push({ price: { lte: budgetCap } });
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
        const fallbackWhere = {
          AND: [
            { active: true },
            { inStock: true },
            ...(skipIds.length > 0 ? [{ id: { notIn: skipIds } }] : []),
          ],
        };
        const fallbackProducts = await prisma.product.findMany({
          where: fallbackWhere,
          orderBy: { popularity: 'desc' },
          take: fallbackLimit,
        });
        finalProducts = fallbackProducts;
      }

    // Two groups: within budget (≤ budget), then slightly over (budget+1 to budget+999). Within sorted price DESC (best value first), over sorted price ASC (cheapest over first). Max 5 within + 3 over.
      if (budgetNum != null && budgetCap != null && finalProducts && finalProducts.length > 0) {
        const within = finalProducts.filter(p => p.price != null && p.price <= budgetNum)
          .sort((a, b) => (b.price || 0) - (a.price || 0))
          .slice(0, 5);
        const slightlyOver = finalProducts.filter(p => p.price != null && p.price > budgetNum && p.price <= budgetCap)
          .sort((a, b) => (a.price || 0) - (b.price || 0))
          .slice(0, 3);
        finalProducts = within.length > 0 || slightlyOver.length > 0 ? [...within, ...slightlyOver] : finalProducts;
      }

      return {
        data: { products: finalProducts || [] },
        tokensUsed: 0,
        found: (finalProducts && finalProducts.length) > 0,
      };
    } catch (error) {
      const dbErrorText = String(error?.message || '');
      const isDbConnectivityError =
        /Can't reach database server|connect|connection|ECONN|P1001|P1002|P1017/i.test(dbErrorText);

      if (isDbConnectivityError) {
        console.error('[SearchAgent] Database connectivity error during semantic search:', dbErrorText);
        return {
          data: {
            products: [],
            found: false,
            dbError: true,
            dbErrorMessage: dbErrorText,
          },
          tokensUsed: 0,
          found: false,
          next: 'no_results_handler',
        };
      }

      throw error;
    }
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
      const mergedEntities = getMergedEntitiesFromContext(context);
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

      const entities = getMergedEntitiesFromContext(context);
      const requestedModel = (entities.model || entities.brand || '').toString().trim();
      const isMoreOptions = context.lastIntent === 'more_options';

      if (isMoreOptions) {
        const topN = node.config.top_n || 5;
        const moreProducts = products.slice(0, topN);
        if (process.env.DEBUG === 'true') console.log(`   [${node.id}] more_options: returning ${moreProducts.length} additional options (no model-first framing)`);
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
        const modelMatches = products.filter(p => productMatchesRequestedModel(p, requestedModel));
        const alternatives = products.filter(p => !productMatchesRequestedModel(p, requestedModel));
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
            const lang = context.language || entities.language || 'english';
            const budgetNum = entities.budget ? parseFloat(String(entities.budget).replace(/,/g, '')) : null;
            const firstBike = ordered[0];
            const isPriceyForBudget = budgetNum != null && firstBike.price != null && firstBike.price > budgetNum;
            const budgetFormatted = budgetNum != null ? `RM ${Number(budgetNum).toLocaleString()}` : '';

            // When we have the model but it's above their budget, always include this line first
            let priceyIntro = '';
            if (isPriceyForBudget && budgetFormatted) {
              if (lang === 'malay') priceyIntro = `Kami ada model yang anda minta, tapi harganya sedikit tinggi untuk anda sebab bajet anda ${budgetFormatted}.`;
              else if (lang === 'chinese') priceyIntro = `我们有您要的型号，但对您来说有点贵，因为您的预算是 ${budgetFormatted}。`;
              else priceyIntro = `We've got the model you asked for, but it's a bit pricey for you since your budget is ${budgetFormatted}.`;
            }

            try {
              const budgetStr = entities.budget ? `RM ${entities.budget}` : 'your budget';
              const firstPrice = firstBike.price != null ? `MYR ${Number(firstBike.price).toLocaleString()}` : '';
              const secondBike = ordered[1];
              // Generic product reasoning prompt (works for any domain)
              const productType = node.config.product_type_label || 'product';
              const systemPrompt = `You are a friendly sales assistant. Return JSON with two short sentences in the user's language (English, Malay, or Chinese): model_reasoning = why the first ${productType} is shown (they asked for this model but it may be a bit above budget). alternative_reasoning = why the second ${productType} is recommended (e.g. fits their budget and is available in their area). Keep each 1 sentence, warm and helpful.`;
              const userPrompt = `User's budget: ${budgetStr}. Area: ${entities.area || 'any'}. They asked for: ${requestedModel}. First ${productType}: ${firstBike.name} (${firstPrice}). Second ${productType}: ${secondBike ? secondBike.name + ' (MYR ' + Number(secondBike.price).toLocaleString() + ')' : 'none'}. Language: ${lang}. Return JSON: { "model_reasoning": "...", "alternative_reasoning": "..." }`;
              // Get config from registry for ranking reasoning
              const rankerConfig = getRoleConfig(AI_ROLES.RANKER);
              const completion = await openai.chat.completions.create({
                model: node.config.model || rankerConfig.model,
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
              const llmModelReasoning = (parsed.model_reasoning || '').trim();
              alternativeReasoning = (parsed.alternative_reasoning || '').trim();
              recommendationReasoning = priceyIntro ? (priceyIntro + (llmModelReasoning ? ' ' + llmModelReasoning : '')) : llmModelReasoning;
            } catch (err) {
              if (process.env.DEBUG === 'true') console.log(`   [${node.id}] Reasoning fallback:`, err.message);
              if (lang === 'malay') {
                recommendationReasoning = priceyIntro || 'Berdasarkan model pilihan anda, saya jumpa padanan — harganya sedikit melebihi bajet.';
                alternativeReasoning = 'Pilihan ini sesuai dengan bajet dan lokasi anda.';
              } else if (lang === 'chinese') {
                recommendationReasoning = priceyIntro || '根据您选的型号我找到了匹配，但价格略超预算。';
                alternativeReasoning = '下面这款在您预算内且您所在地区有货。';
              } else {
                recommendationReasoning = priceyIntro || 'Based on your preferred model I found a match — it\'s a bit above your budget.';
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
        // Get config from registry (can be overridden by node.config)
        const rankerConfig = getRoleConfig(AI_ROLES.RANKER);
        const model = node.config.model || rankerConfig.model;
        const temperature = node.config.temperature ?? rankerConfig.temperature;
        const maxTokens = node.config.max_tokens || rankerConfig.maxTokens;

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
        // Get config from registry for generic ML nodes
        const rankerConfig = getRoleConfig(AI_ROLES.RANKER);
        const model = node.config.model || rankerConfig.model;
        const temperature = node.config.temperature ?? rankerConfig.temperature;
        const maxTokens = node.config.max_tokens || rankerConfig.maxTokens;

        const completion = await openai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature,
          max_tokens: maxTokens,
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
                  "To recommend the best products, please share your budget (e.g. RM 5,000), area (e.g. Puchong), and preferred model if any.",
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

}

export default SearchAgent;

