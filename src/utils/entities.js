/**
 * Entity helpers shared across agents.
 *
 * - getLatestEntitiesFromContext: returns the most recent non-empty entities object
 *   produced by any node in the current workflow turn.
 * - getMergedEntitiesFromContext: merges persistent/session entities with the
 *   most recent entities from this turn, so downstream nodes see a unified view.
 */

export function getLatestEntitiesFromContext(context) {
  const results = context.allResults || [];
  for (let i = results.length - 1; i >= 0; i--) {
    const entities = results[i]?.data?.entities;
    if (entities && typeof entities === 'object' && Object.keys(entities).length > 0) {
      return entities;
    }
  }
  return context.lastResult?.data?.entities || {};
}

export function getMergedEntitiesFromContext(context) {
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

  return latestEntities ? { ...base, ...latestEntities } : base;
}

