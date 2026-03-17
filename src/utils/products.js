/**
 * Product-related helper utilities shared across agents.
 */

export function productMatchesRequestedModel(product, requestedModel) {
  if (!requestedModel || typeof requestedModel !== 'string') return true;
  const n = (s) => (s || '').toLowerCase().trim();
  const key = n(requestedModel);
  const name = n(product.name);
  const brand = n(product.brand || '');
  const model = n(product.features?.model || '');
  return name.includes(key) || (brand + ' ' + model).trim().includes(key) || model.includes(key);
}

