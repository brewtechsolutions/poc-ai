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
 * Load full product/object from ledger using entities from a resolved selection.
 */
export function resolveProductFromLedger(context, entities) {
  if (!entities?.selected_id) return null;
  const sets = getSets(context);
  const sid = String(entities.selected_id);
  const setId = entities.resolved_from_set;

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
