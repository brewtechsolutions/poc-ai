import crypto from 'crypto';

const MAX_SETS = 20;

function newSetId() {
  return crypto.randomUUID();
}

function itemTitle(p, i) {
  const features = p?.features && typeof p.features === 'object' ? p.features : {};
  const name = (p?.name || '').trim();
  const model = (features.model || '').trim();
  if (model && name && !name.toLowerCase().includes(model.toLowerCase())) {
    return `${name} ${model}`.trim();
  }
  return name || model || p?.title || `Item ${i + 1}`;
}

function stableIdForProduct(p, i) {
  if (p?.id != null) return String(p.id);
  if (p?.sku != null) return String(p.sku);
  if (p?.features && typeof p.features === 'object' && p.features.model != null) {
    return String(p.features.model);
  }
  return String(i);
}

/**
 * Append a new option set to the session ledger (call when assistant shows a numbered list).
 */
export function appendOptionSet(session, products, { turnIndex = 0, context: userContext = '' } = {}) {
  if (!products || !Array.isArray(products) || products.length === 0) return null;
  if (!session.optionSets) session.optionSets = [];

  const set = {
    id: newSetId(),
    turnIndex,
    context: userContext,
    createdAt: Date.now(),
    items: products.map((p, i) => ({
      displayIndex: i + 1,
      stableId: stableIdForProduct(p, i),
      title: itemTitle(p, i),
      raw: p,
    })),
  };

  session.optionSets.push(set);
  if (session.optionSets.length > MAX_SETS) {
    session.optionSets = session.optionSets.slice(-MAX_SETS);
  }
  session.activeSetId = set.id;
  return set;
}

function getSets(contextOrSession) {
  return contextOrSession?.optionSets ?? [];
}

/**
 * Resolve numeric pick or title substring against option history (newest sets first).
 * @returns {{ item: object, set: object } | null}
 */
export function resolveSelection(contextOrSession, input) {
  const sets = getSets(contextOrSession);
  if (!sets.length) return null;

  const trimmed = String(input || '').trim();
  if (!trimmed) return null;

  const num = parseInt(trimmed, 10);
  if (!Number.isNaN(num) && num >= 1 && /^[1-9]\d*\.?$/.test(trimmed)) {
    for (let i = sets.length - 1; i >= 0; i--) {
      const set = sets[i];
      const item = set.items.find(it => it.displayIndex === num);
      if (item) return { item, set };
    }
    return null;
  }

  const query = trimmed.toLowerCase();
  for (let i = sets.length - 1; i >= 0; i--) {
    const set = sets[i];
    const item = set.items.find(it => it.title.toLowerCase().includes(query));
    if (item) return { item, set };
  }

  return null;
}

/**
 * Normalize selected_index from entities (router may pass string).
 */
function resolvedDisplayIndex(entities) {
  const raw = entities?.selected_index;
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Numeric-only replies refer to the Nth item of the **latest** assistant list (same UX as AnalysisAgent).
 * Use when stableId / setId lookup failed but the session still has a current option set (e.g. after DB load).
 */
export function resolveProductFromLatestNumberedPick(context, entities, userMessage) {
  const trimmed = String(userMessage || '').trim();
  if (!/^[1-9]\d*\.?$/.test(trimmed)) return null;
  const idx = resolvedDisplayIndex(entities);
  if (idx == null || idx < 1) return null;
  const sets = getSets(context);
  if (!sets.length) return null;
  const latest = sets[sets.length - 1];
  const item = latest.items?.find(it => it.displayIndex === idx);
  return item?.raw ?? null;
}

/**
 * Load full product/object from ledger using entities from a resolved selection.
 * Prefer (resolved_from_set + display index) so we return the exact list cell the user chose;
 * stableId alone can match the wrong row if duplicate IDs or duplicate model keys appear in one list.
 */
export function resolveProductFromLedger(context, entities) {
  const sets = getSets(context);
  if (!sets.length || !entities) return null;

  const setId = entities.resolved_from_set;
  const idx = resolvedDisplayIndex(entities);
  if (setId && idx != null && idx >= 1) {
    const set = sets.find(s => s.id === setId);
    const item = set?.items?.find(it => it.displayIndex === idx);
    if (item?.raw) return item.raw;
  }

  if (!entities.selected_id) return null;
  const sid = String(entities.selected_id);

  if (setId) {
    const set = sets.find(s => s.id === setId);
    const item = set?.items.find(it => String(it.stableId) === sid);
    return item?.raw ?? null;
  }

  for (let i = sets.length - 1; i >= 0; i--) {
    const item = sets[i].items.find(it => String(it.stableId) === sid);
    if (item) return item.raw;
  }
  return null;
}
