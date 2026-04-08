/**
 * Context Builder - Builds AI context injection from conversation memory.
 * Provides consistent context strings for injection into AI calls.
 */

/**
 * Build a context summary string for AI injection
 * @param {object} memoryContext - Return value from MemoryAgent.getContext()
 * @param {object} currentIntent - Current intent from AnalysisAgent
 */
export function buildContextSummary(memoryContext, currentIntent) {
  if (!memoryContext) {
    return "No prior conversation context available.";
  }

  const parts = [];

  // Conversation phase
  if (memoryContext.phase && memoryContext.phase !== 'initial') {
    parts.push(`Current phase: ${memoryContext.phase}`);
  }

  // Pending questions (unresolved)
  if (memoryContext.pendingQuestions && memoryContext.pendingQuestions.length > 0) {
    const questions = memoryContext.pendingQuestions.map(q => q.question).join('; ');
    parts.push(`Awaiting your follow-up on: ${questions}`);
  }

  // Context tags (preferences/interests discovered)
  if (memoryContext.tags && memoryContext.tags.length > 0) {
    parts.push(`User context: ${memoryContext.tags.join(', ')}`);
  }

  // Last entities (what user was looking for)
  if (memoryContext.lastEntities && Object.keys(memoryContext.lastEntities).length > 0) {
    const entitySummary = Object.entries(memoryContext.lastEntities)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('; ');
    parts.push(`Previous entities: ${entitySummary}`);
  }

  // Last shown products (avoid repetition)
  if (memoryContext.lastShownProducts && memoryContext.lastShownProducts.length > 0) {
    parts.push(`${memoryContext.lastShownProducts.length} products already shown to user (do not repeat unless asked)`);
  }

  // Language preference
  if (memoryContext.language) {
    parts.push(`User language: ${memoryContext.language}`);
  }

  return parts.length > 0 ? parts.join('\n') : "No specific context accumulated yet.";
}

/**
 * Build a conversation history string for AI context
 * @param {Array} history - conversationHistory array from MemoryAgent
 * @param {number} maxTurns - Maximum number of turns to include
 */
export function buildHistoryString(history, maxTurns = 10) {
  if (!history || history.length === 0) {
    return "No prior conversation.";
  }

  const recent = history.slice(-maxTurns);
  return recent.map(turn => {
    const role = turn.role === 'user' ? 'User' : 'Assistant';
    return `${role}: ${turn.content}`;
  }).join('\n');
}

/**
 * Build full system context for AI calls.
 * Combines all context pieces into a single prompt injection.
 */
export function buildFullContext(memoryContext, currentIntent) {
  const summary = buildContextSummary(memoryContext, currentIntent);
  const history = buildHistoryString(memoryContext?.history);

  return `CONVERSATION CONTEXT:
${summary}

RECENT CONVERSATION:
${history}`;
}