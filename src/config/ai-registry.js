/**
 * AI Registry - Central configuration for models, roles, and tool access
 * 
 * This registry eliminates hardcoded model strings and provides a single source
 * of truth for AI agent configuration. All agents should read from this registry.
 */

import { TOKEN_CONFIG } from './openai.js';

/**
 * Semantic roles for different AI agent types
 */
export const AI_ROLES = {
  ANALYZER: 'analyzer',           // Intent classification, entity extraction
  ROUTER: 'router',                // Intent routing (lightweight, no LLM)
  RETRIEVER: 'retriever',          // Product/knowledge retrieval (DB queries)
  RANKER: 'ranker',                // Result ranking and relevance scoring
  FORMATTER: 'formatter',          // Response formatting (templates)
  OPTIMIZER: 'optimizer',          // Response style optimization
  RESPONDER: 'responder',          // Final response generation
  ESCALATOR: 'escalator',          // Agent escalation handling
  VISION: 'vision',                // Image analysis
  SPEECH: 'speech',                // Voice transcription
};

/**
 * Model assignments per role
 * Higher accuracy roles use gpt-4o, cost-sensitive roles use gpt-4o-mini
 */
export const MODEL_ASSIGNMENTS = {
  [AI_ROLES.ANALYZER]: process.env.ANALYZER_MODEL || 'gpt-4o',
  [AI_ROLES.RANKER]: process.env.RANKER_MODEL || 'gpt-4o-mini',
  [AI_ROLES.OPTIMIZER]: process.env.OPTIMIZER_MODEL || 'gpt-4o-mini',
  [AI_ROLES.ESCALATOR]: process.env.ESCALATOR_MODEL || 'gpt-4o-mini',
  [AI_ROLES.VISION]: process.env.VISION_MODEL || 'gpt-4o',
  [AI_ROLES.SPEECH]: process.env.SPEECH_MODEL || 'whisper-1',
  // Router, Retriever, Formatter, Responder don't use LLM directly
  [AI_ROLES.ROUTER]: null,
  [AI_ROLES.RETRIEVER]: null,
  [AI_ROLES.FORMATTER]: null,
  [AI_ROLES.RESPONDER]: null,
};

/**
 * Temperature settings per role
 */
export const TEMPERATURE_SETTINGS = {
  [AI_ROLES.ANALYZER]: TOKEN_CONFIG.TEMPERATURE.STRICT,      // 0.2 - precise classification
  [AI_ROLES.RANKER]: TOKEN_CONFIG.TEMPERATURE.STRICT,        // 0.2 - consistent ranking
  [AI_ROLES.OPTIMIZER]: TOKEN_CONFIG.TEMPERATURE.BALANCED,   // 0.3 - natural but controlled
  [AI_ROLES.ESCALATOR]: TOKEN_CONFIG.TEMPERATURE.STRICT,     // 0.2 - precise escalation
  [AI_ROLES.VISION]: TOKEN_CONFIG.TEMPERATURE.STRICT,        // 0.2 - accurate image analysis
};

/**
 * Max tokens per role
 */
export const MAX_TOKENS_SETTINGS = {
  [AI_ROLES.ANALYZER]: 250,        // Intent classification is concise
  [AI_ROLES.RANKER]: 400,          // Ranking with reasoning
  [AI_ROLES.OPTIMIZER]: 600,       // Response optimization
  [AI_ROLES.ESCALATOR]: 200,       // Escalation messages
  [AI_ROLES.VISION]: 500,          // Image analysis
};

/**
 * Tool access per role
 * Defines which tools/operations each role can access
 */
export const TOOL_ACCESS = {
  [AI_ROLES.ANALYZER]: [
    'classify_message',            // Intent/entity extraction tool
  ],
  [AI_ROLES.RETRIEVER]: [
    'semantic_search',              // Product search
    'get_price',                    // Price lookup
    'get_specs',                    // Specification lookup
  ],
  [AI_ROLES.RANKER]: [
    'rank_products',                // Product ranking
  ],
  [AI_ROLES.ESCALATOR]: [
    'assign_agent',                 // Agent assignment
  ],
};

/**
 * Get model for a role
 */
export function getModelForRole(role) {
  return MODEL_ASSIGNMENTS[role] || null;
}

/**
 * Get temperature for a role
 */
export function getTemperatureForRole(role) {
  return TEMPERATURE_SETTINGS[role] ?? TOKEN_CONFIG.TEMPERATURE.BALANCED;
}

/**
 * Get max tokens for a role
 */
export function getMaxTokensForRole(role) {
  return MAX_TOKENS_SETTINGS[role] ?? TOKEN_CONFIG.MAX_TOKENS_PER_REQUEST;
}

/**
 * Get available tools for a role
 */
export function getToolsForRole(role) {
  return TOOL_ACCESS[role] || [];
}

/**
 * Check if a role has access to a specific tool
 */
export function hasToolAccess(role, toolName) {
  const tools = getToolsForRole(role);
  return tools.includes(toolName);
}

/**
 * Get full configuration for a role
 */
export function getRoleConfig(role) {
  return {
    role,
    model: getModelForRole(role),
    temperature: getTemperatureForRole(role),
    maxTokens: getMaxTokensForRole(role),
    tools: getToolsForRole(role),
  };
}

export default {
  AI_ROLES,
  MODEL_ASSIGNMENTS,
  TEMPERATURE_SETTINGS,
  MAX_TOKENS_SETTINGS,
  TOOL_ACCESS,
  getModelForRole,
  getTemperatureForRole,
  getMaxTokensForRole,
  getToolsForRole,
  hasToolAccess,
  getRoleConfig,
};
