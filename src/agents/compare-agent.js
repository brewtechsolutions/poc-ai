import prisma from '../config/database.js';
import openai from '../config/openai.js';
import { matchesComparativeFollowUp } from '../utils/comparative-follow-up.js';
import { appendOptionSet } from '../utils/session-option-sets.js';

/**
 * Compare Agent — handles all bike comparison logic.
 *
 * o3-mini parses compare intent, then fetchProductsForCompare queries the DB dynamically.
 * No hardcoded brand lists or regex maintenance.
 *
 * Used via: CompareAgent.handleCompareBikes.call(workflowEngine, node, context)
 * so it retains access to this.runBikeComparisonMany, this.workflow, etc.
 */
class CompareAgent {
  /**
   * Parse compare intent using o3-mini.
   * Falls back to scope "all" (safe default — compares what's shown).
   *
   * @param {string} userMessage
   * @param {Array}  latestSetItems  — items from the latest option set (can be null)
   * @returns {Promise<{scope, brands, models, type, refs, attribute}>}
   */
  static async parseCompareIntent(userMessage, latestSetItems) {
    const systemPrompt = `You are a compare-intent parser for a motorcycle sales chatbot.

Given the user message and the current shown list (if any), return ONLY JSON with this exact shape:
{
  "scope": "all" | "brand" | "pair" | "type" | "attribute",
  "brands": string[],
  "models": string[],
  "type": string | null,
  "refs": string[],
  "attribute": string | null
}

Scope rules:
- "all"       — compare everything currently shown (e.g. "compare all", "compare everything")
- "brand"     — compare all of a specific brand (e.g. "compare all yamaha", "bandingkan semua yamaha")
- "pair"      — compare exactly two items by name or number (e.g. "compare y15zr vs rs150r", "compare 1 and 3")
- "type"      — compare by type/category (e.g. "compare all 150cc", "compare scooters")
- "attribute" — follow-up question about a specific attribute (e.g. "which is more fuel efficient?", "yang mana lebih menjimatkan?")

Ambiguous cases:
- "compare yamaha" with one brand → scope: "brand"
- "compare yamaha vs honda" → scope: "brand" (multiple brands)
- bare "compare" with exactly 2 items shown → scope: "pair", refs: ["1", "2"]
- brand vs brand without explicit "compare all" → scope: "brand"

Return null refs[] when scope is "all" or "brand" with no specific items mentioned.
Return empty brands[] when scope is "pair" with numeric refs only.

Be thorough with Malay / Chinese input ("bandingkan", "比较", etc.).`;

    const itemList = Array.isArray(latestSetItems) && latestSetItems.length > 0
      ? latestSetItems
          .map((it, i) => `  ${i + 1}. ${it.title} (stableId: ${it.stableId})`)
          .join('\n')
      : '(no items currently shown)';

    const userContent =
      `${systemPrompt}

Current shown list:
${itemList}

User message: "${userMessage}"`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'o3-mini',
        messages: [{ role: 'user', content: userContent }],
        max_completion_tokens: 500,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'compare_intent',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                scope:     { type: 'string', enum: ['all', 'brand', 'pair', 'type', 'attribute'] },
                brands:    { type: 'array', items: { type: 'string' } },
                models:    { type: 'array', items: { type: 'string' } },
                type:      { type: ['string', 'null'] },
                refs:      { type: 'array', items: { type: 'string' } },
                attribute: { type: ['string', 'null'] },
              },
              required: ['scope', 'brands', 'models', 'type', 'refs', 'attribute'],
              additionalProperties: false,
            },
          },
        },
      });

      const raw = completion.choices?.[0]?.message?.content;
      if (!raw) throw new Error('empty response');

      return JSON.parse(raw);
    } catch (err) {
      console.warn('[CompareAgent] parseCompareIntent failed, defaulting to scope=all:', err.message);
      return { scope: 'all', brands: [], models: [], type: null, refs: [], attribute: null };
    }
  }

  /**
   * Fetch products from DB using brands/models/type filters.
   * Returns deduplicated Prisma rows.
   *
   * @param {{ brands: string[], models: string[], type: string|null }} filters
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  static async fetchProductsForCompare(filters, limit = 8) {
    const { brands, models, type } = filters;
    const hasBrands = Array.isArray(brands) && brands.some(b => b.trim());
    const hasModels = Array.isArray(models) && models.some(m => m.trim());
    const hasType   = type && type.trim();

    const where = { active: true, inStock: true };

    if (hasBrands || hasModels) {
      where.OR = [];
      if (hasBrands) {
        for (const brand of brands) {
          const b = brand.trim().toLowerCase();
          if (b) where.OR.push({ brand: { contains: b, mode: 'insensitive' } });
        }
      }
      if (hasModels) {
        for (const model of models) {
          const m = model.trim().toLowerCase();
          if (m) where.OR.push({ name: { contains: m, mode: 'insensitive' } });
        }
      }
      if (hasBrands) {
        where.AND = brands
          .filter(b => b.trim())
          .map(brand => ({ brand: { contains: brand.trim(), mode: 'insensitive' } }));
      }
    } else if (hasType) {
      const t = type.trim().toLowerCase();
      where.OR = [
        { category:    { contains: t, mode: 'insensitive' } },
        { description: { contains: t, mode: 'insensitive' } },
        { subcategory: { contains: t, mode: 'insensitive' } },
      ];
    }

    try {
      const products = await prisma.product.findMany({
        where,
        take: limit,
        orderBy: { popularity: 'desc' },
      });
      return CompareAgent._deduplicateProducts(products);
    } catch (err) {
      console.error('[CompareAgent] fetchProductsForCompare error:', err.message);
      return [];
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  /** Remove duplicate ids, preserving order. */
  static _deduplicateProducts(products) {
    const seen = new Set();
    return products.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }

  /** Strip filler words so "another yamaha" → "yamaha". */
  static _normalizeRef(ref) {
    if (ref == null || ref === '') return '';
    return String(ref)
      .trim()
      .replace(/^(another|other|the|a|an|my|this|that)\s+/i, '')
      .trim();
  }

  /**
   * Filter a list of ledger items by brands and/or models.
   * @param {Array}  items
   * @param {string[]} brands
   * @param {string[]} models
   * @returns {Array}
   */
  static _filterItemsByBrandsOrModels(items, brands, models) {
    if (!Array.isArray(items)) return [];
    const hasFilter = brands.some(b => b.trim()) || models.some(m => m.trim());
    if (!hasFilter) return items;

    return items.filter(it => {
      const title = String(it.title || '').toLowerCase();
      const name  = String(it.raw?.name  || '').toLowerCase();
      const brand = String(it.raw?.brand || '').toLowerCase();

      const brandMatch = brands
        .filter(b => b.trim())
        .some(b => brand.includes(b.trim().toLowerCase()) || title.includes(b.trim().toLowerCase()));

      const modelMatch = models
        .filter(m => m.trim())
        .some(m => name.includes(m.trim().toLowerCase()) || title.includes(m.trim().toLowerCase()));

      return brandMatch || modelMatch;
    });
  }

  /** Build a clarification message for ambiguous refs. */
  static _buildAmbiguousResponse(refs, matches1, matches2) {
    const lines = [];
    if (matches1.length > 1) {
      lines.push(`I found multiple matches for "${refs[0]}":`);
      lines.push(matches1.map(it => `  ${it.displayIndex}. ${it.title}`).join('\n'));
      lines.push('');
    }
    if (matches2.length > 1) {
      lines.push(`I found multiple matches for "${refs[1]}":`);
      lines.push(matches2.map(it => `  ${it.displayIndex}. ${it.title}`).join('\n'));
      lines.push('');
    }
    lines.push('Please reply with two numbers, e.g. "compare 1 and 3".');
    return lines.join('\n');
  }

  /**
   * Resolve two refs from the ledger (returns {item1, item2} or {ambiguous, matches1, matches2, pendingCompare}).
   */
  static async _resolvePairFromLedger(items, refs) {
    const refMatchVariants = (raw) => {
      const q0 = String(raw || '').toLowerCase().trim();
      const collapsed = q0.replace(/(.)\1+/g, '$1');
      return collapsed !== q0 ? [q0, collapsed] : [q0];
    };

    const resolveRef = (ref) => {
      if (!ref) return [];
      const num = parseInt(ref, 10);
      if (!Number.isNaN(num)) {
        const item = items.find(it => it.displayIndex === num);
        return item ? [item] : [];
      }
      const seen = new Set();
      const matches = [];
      for (const q of refMatchVariants(ref)) {
        for (const it of items) {
          const title = String(it.title || '').toLowerCase();
          const name  = String(it.raw?.name  || '').toLowerCase();
          const brand = String(it.raw?.brand || '').toLowerCase();
          if (!title.includes(q) && !name.includes(q) && !brand.includes(q)) continue;
          const id = String(it.stableId ?? `${it.displayIndex}`);
          if (seen.has(id)) continue;
          seen.add(id);
          matches.push(it);
        }
        if (matches.length > 0) break;
      }
      return matches;
    };

    const matches1 = refs[0] ? resolveRef(refs[0]) : [];
    const matches2 = refs[1] ? resolveRef(refs[1]) : [];

    const isAmbiguous1 = matches1.length > 1;
    const isAmbiguous2 = matches2.length > 1;

    if (isAmbiguous1 || isAmbiguous2) {
      let clarifyMsg = '';
      if (isAmbiguous1 && isAmbiguous2) {
        const list1 = matches1.map(it => `${it.displayIndex}. ${it.title}`).join('\n');
        const list2 = matches2.map(it => `${it.displayIndex}. ${it.title}`).join('\n');
        clarifyMsg = `I found multiple matches!\n\nFor "${refs[0]}":\n${list1}\n\nFor "${refs[1]}":\n${list2}\n\nPlease reply with two numbers, e.g. "compare 1 and 3".`;
      } else if (isAmbiguous1) {
        const list1 = matches1.map(it => `${it.displayIndex}. ${it.title}`).join('\n');
        clarifyMsg = `I found multiple matches for "${refs[0]}":\n${list1}\n\nPlease pick one by number.`;
      } else {
        const list2 = matches2.map(it => `${it.displayIndex}. ${it.title}`).join('\n');
        clarifyMsg = `I found multiple matches for "${refs[1]}":\n${list2}\n\nPlease pick one by number.`;
      }

      let pendingCompare = null;
      if (!isAmbiguous1 && matches1.length === 1 && !isAmbiguous2) {
        pendingCompare = { resolvedItem: matches1[0] };
      } else if (!isAmbiguous2 && matches2.length === 1 && !isAmbiguous1) {
        pendingCompare = { resolvedItem: matches2[0] };
      }

      return { ambiguous: true, matches1, matches2, pendingCompare, clarifyMsg };
    }

    const item1 = matches1[0] || null;
    const item2 = matches2[0] || null;

    if (!item1 && !item2 && refs[0] && refs[1]) return null;

    return { item1, item2 };
  }

  /** Resolve two refs directly from DB (used when ledger has no matches). */
  static async _resolvePairFromDb(ref1, ref2) {
    if (ref1.length < 2 || ref2.length < 2 || ref1 === ref2) return null;

    const findCandidates = async (q) =>
      prisma.product.findMany({
        where: {
          active:  true,
          inStock: true,
          OR: [
            { brand:      { contains: q, mode: 'insensitive' } },
            { name:       { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
          ],
        },
        take: 15,
        orderBy: { popularity: 'desc' },
      });

    try {
      const [a, b] = await Promise.all([findCandidates(ref1), findCandidates(ref2)]);
      const p1 = a[0];
      if (!p1) return null;
      const p2 = b.find(p => p.id !== p1.id) || b[0];
      if (!p2 || p1.id === p2.id) return null;
      return [p1, p2];
    } catch (e) {
      console.error('[CompareAgent] DB fallback error:', e.message);
      return null;
    }
  }

  // ─── Main entry point ───────────────────────────────────────────────────────

  /**
   * Entry point — called via CompareAgent.handleCompareBikes.call(workflowEngine, node, context).
   * Uses `this` (WorkflowEngine instance) for runBikeComparisonMany, workflow, etc.
   */
  static async handleCompareBikes(node, context) {
    const language   = context.language || 'english';
    const message    = (context.user_message || '').trim();
    let optionSets   = context.optionSets || context.metadata?.optionSets || [];
    let latestSet    = optionSets[optionSets.length - 1];

    // Rebuild from lastShownProducts when session ledger is missing
    if (!latestSet || !Array.isArray(latestSet.items) || latestSet.items.length < 2) {
      const lastShown = context.lastShownProducts || context.metadata?.lastShownProducts || null;
      if (Array.isArray(lastShown) && lastShown.length >= 2) {
        const tempSession = { optionSets: Array.isArray(optionSets) ? [...optionSets] : [] };
        appendOptionSet(tempSession, lastShown, {
          turnIndex: context.turnCount ?? 0,
          context: 'compare-fallback-lastShown',
        });
        optionSets = tempSession.optionSets;
        latestSet   = optionSets[optionSets.length - 1];
        context.optionSets = optionSets;
        if (context.metadata) context.metadata.optionSets = optionSets;
      }
    }

    const isNewCompareRequest = /compare|vs\.?|versus|bandingkan|比较/i.test(message);
    if (isNewCompareRequest) {
      context.pendingCompare = null;
    }

    const turnOnly     = context.lastResult?.data?.entitiesForTurn;
    const entities     = (turnOnly && typeof turnOnly === 'object' && Object.keys(turnOnly).length > 0)
      ? { ...(context.entities || {}), ...turnOnly }
      : context.entities || {};
    const pendingCompare = isNewCompareRequest
      ? null
      : (context.pendingCompare || entities.pendingCompare);
    const selectedRef    = (entities.selectedRef != null && String(entities.selectedRef).trim() !== '')
      ? String(entities.selectedRef).trim()
      : '';

    const notFoundTpl  = this.workflow.templates?.compare_bikes_not_found;
    const notFoundMsg  = notFoundTpl?.[language] || notFoundTpl?.english
      || 'Please pick two bikes from the current list to compare.';
    const invalidPickMsg = notFoundTpl?.[language] || notFoundTpl?.english
      || 'Please pick a valid number from the list.';

    // Handle clarification flow (pendingCompare)
    if (pendingCompare?.resolvedItem && selectedRef) {
      let clarifiedItem = null;
      const numPick = parseInt(selectedRef, 10);
      if (!Number.isNaN(numPick)) {
        clarifiedItem = latestSet?.items?.find(it => it.displayIndex === numPick) || null;
      } else {
        const q = selectedRef.toLowerCase();
        clarifiedItem = (latestSet?.items || []).find(it => {
          const title = String(it.title || '').toLowerCase();
          const name  = String(it.raw?.name  || '').toLowerCase();
          return title.includes(q) || name.includes(q);
        }) || null;
      }

      if (!clarifiedItem) {
        return {
          data:   { finalResponse: invalidPickMsg, formatted: invalidPickMsg, response: invalidPickMsg, pendingCompare },
          tokensUsed: 0,
          next:   node.config?.next || 'response_sender',
        };
      }

      const resolvedItem = pendingCompare.resolvedItem;
      const rawA = resolvedItem?.raw;
      const rawB = clarifiedItem?.raw;
      if (!rawA || !rawB) {
        const msg = 'Sorry, I could not find one of the bikes. Please try again.';
        return { data: { finalResponse: msg, formatted: msg, response: msg, pendingCompare: null }, tokensUsed: 0, next: node.config?.next || 'response_sender' };
      }
      if (String(resolvedItem.stableId) === String(clarifiedItem.stableId)) {
        return { data: { finalResponse: notFoundMsg, formatted: notFoundMsg, response: notFoundMsg, pendingCompare }, tokensUsed: 0, next: node.config?.next || 'response_sender' };
      }

      return this.runBikeComparison(resolvedItem, clarifiedItem, language, node);
    }

    // ── Use o3-mini intent parser for all new compare requests ──
    const intent = await CompareAgent.parseCompareIntent(message, latestSet?.items || null);
    const { scope, brands, models, type, refs } = intent;

    // Comparative follow-up (attribute question)
    if (scope === 'attribute' || matchesComparativeFollowUp(message, this.getAnalysisAgentConfig())) {
      const followItems = this.constructor.resolveItemsForComparativeFollowUp(context, latestSet);
      if (followItems && followItems.length >= 2) {
        return this.runComparativeAttributeAnswer(followItems, message, language, node);
      }
    }

    // ── scope: "all" ──
    if (scope === 'all') {
      if (latestSet?.items?.length >= 2) {
        context.lastShownProducts = latestSet.items.map(it => it.raw).filter(Boolean);
        return this.runBikeComparisonMany(latestSet.items, language, node);
      }
      const dbProducts = await CompareAgent.fetchProductsForCompare({ brands: [], models: [], type: null }, 8);
      if (dbProducts.length < 2) {
        return { data: { finalResponse: notFoundMsg, formatted: notFoundMsg, response: notFoundMsg, pendingCompare: null }, tokensUsed: 0, next: node.config?.next || 'response_sender' };
      }
      const items = dbProducts.map((p, i) => ({ displayIndex: i + 1, stableId: String(p.id), title: p.name, raw: p }));
      return this.runBikeComparisonMany(items, language, node);
    }

    // ── scope: "pair" ──
    if (scope === 'pair') {
      if (!latestSet?.items?.length >= 2) {
        if (refs.length >= 2) {
          const ref1 = CompareAgent._normalizeRef(refs[0]);
          const ref2 = CompareAgent._normalizeRef(refs[1]);
          if (ref1 && ref2) {
            const pair = await CompareAgent._resolvePairFromDb(ref1, ref2);
            if (pair) {
              const tempSession = { optionSets: [] };
              appendOptionSet(tempSession, pair, { turnIndex: context.turnCount ?? 0, context: 'compare-fallback-db' });
              const newSets = tempSession.optionSets;
              const newLatest = newSets[newSets.length - 1];
              context.optionSets = newSets;
              if (context.metadata) context.metadata.optionSets = newSets;
              return this.runBikeComparisonMany([...newLatest.items], language, node);
            }
          }
        }
        return { data: { finalResponse: notFoundMsg, formatted: notFoundMsg, response: notFoundMsg, pendingCompare: null }, tokensUsed: 0, next: node.config?.next || 'response_sender' };
      }

      const resolved = await CompareAgent._resolvePairFromLedger(latestSet.items, refs);
      if (resolved?.ambiguous) {
        const clarifyMsg = CompareAgent._buildAmbiguousResponse(refs, resolved.matches1 || [], resolved.matches2 || []);
        return {
          data:   { finalResponse: clarifyMsg, formatted: clarifyMsg, response: clarifyMsg, pendingCompare: resolved.pendingCompare },
          tokensUsed: 0,
          next:   node.config?.next || 'response_sender',
        };
      }
      if (resolved?.item1 && resolved?.item2) {
        if (String(resolved.item1.stableId) === String(resolved.item2.stableId)) {
          return { data: { finalResponse: notFoundMsg, formatted: notFoundMsg, response: notFoundMsg, pendingCompare: null }, tokensUsed: 0, next: node.config?.next || 'response_sender' };
        }
        return this.runBikeComparison(resolved.item1, resolved.item2, language, node);
      }

      // Refs not found in ledger — DB fallback
      if (refs.length >= 2) {
        const ref1 = CompareAgent._normalizeRef(refs[0]);
        const ref2 = CompareAgent._normalizeRef(refs[1]);
        if (ref1 && ref2) {
          const pair = await CompareAgent._resolvePairFromDb(ref1, ref2);
          if (pair) {
            const tempSession = { optionSets: [] };
            appendOptionSet(tempSession, pair, { turnIndex: context.turnCount ?? 0, context: 'compare-fallback-db' });
            const newSets = tempSession.optionSets;
            const newLatest = newSets[newSets.length - 1];
            context.optionSets = newSets;
            if (context.metadata) context.metadata.optionSets = newSets;
            return this.runBikeComparisonMany([...newLatest.items], language, node);
          }
        }
      }

      return { data: { finalResponse: notFoundMsg, formatted: notFoundMsg, response: notFoundMsg, pendingCompare: null }, tokensUsed: 0, next: node.config?.next || 'response_sender' };
    }

    // ── scope: "brand" ──
    if (scope === 'brand') {
      let filtered = latestSet?.items
        ? CompareAgent._filterItemsByBrandsOrModels(latestSet.items, brands, models)
        : [];

      if (filtered.length < 2) {
        const dbProducts = await CompareAgent.fetchProductsForCompare({ brands, models, type: null }, 8);
        if (dbProducts.length >= 2) {
          filtered = dbProducts.map((p, i) => ({
            displayIndex: i + 1,
            stableId:     String(p.id),
            title:        p.name,
            raw:          p,
          }));
        }
      }

      if (filtered.length < 2) {
        const brandName = brands.filter(Boolean).join(', ');
        const msg = brandName
          ? `Sorry, I couldn't find enough ${brandName} models to compare.`
          : notFoundMsg;
        return { data: { finalResponse: msg, formatted: msg, response: msg, pendingCompare: null }, tokensUsed: 0, next: node.config?.next || 'response_sender' };
      }

      return this.runBikeComparisonMany(filtered, language, node);
    }

    // ── scope: "type" ──
    if (scope === 'type') {
      let filtered = latestSet?.items
        ? CompareAgent._filterItemsByBrandsOrModels(latestSet.items, [], [])
            .filter(it => {
              const cat = String(it.raw?.category || it.raw?.subcategory || it.raw?.description || '').toLowerCase();
              return cat.includes((type || '').toLowerCase());
            })
        : [];

      if (filtered.length < 2) {
        const dbProducts = await CompareAgent.fetchProductsForCompare({ brands: [], models: [], type }, 8);
        if (dbProducts.length >= 2) {
          filtered = dbProducts.map((p, i) => ({
            displayIndex: i + 1,
            stableId:     String(p.id),
            title:        p.name,
            raw:          p,
          }));
        }
      }

      if (filtered.length < 2) {
        const msg = `Sorry, I couldn't find enough ${type} bikes to compare.`;
        return { data: { finalResponse: msg, formatted: msg, response: msg, pendingCompare: null }, tokensUsed: 0, next: node.config?.next || 'response_sender' };
      }

      return this.runBikeComparisonMany(filtered, language, node);
    }

    // Fallback — compare all available
    if (latestSet?.items?.length >= 2) {
      return this.runBikeComparisonMany(latestSet.items, language, node);
    }

    return { data: { finalResponse: notFoundMsg, formatted: notFoundMsg, response: notFoundMsg, pendingCompare: null }, tokensUsed: 0, next: node.config?.next || 'response_sender' };
  }
}

export default CompareAgent;
