/**
 * Comparative follow-up detection: patterns live in workflow.json under
 * analysis_agent.config.comparative_follow_up_rules and comparative_follow_up_exclude_rules.
 * Pass the analysis agent config from WorkflowEngine.getAnalysisAgentConfig() or AnalysisAgent fastPath config.
 */

function testRules(message, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return false;
  for (const rule of rules) {
    if (!rule?.pattern) continue;
    try {
      const re = new RegExp(rule.pattern, rule.flags ?? '');
      if (re.test(message)) return true;
    } catch (err) {
      console.warn('[comparative-follow-up] Invalid regex in workflow:', rule.pattern, err.message);
    }
  }
  return false;
}

/**
 * @param {string} message - User message
 * @param {object} [config] - analysis_agent node config from workflow (must include comparative_follow_up_*_rules)
 * @returns {boolean}
 */
export function matchesComparativeFollowUp(message, config = {}) {
  const m = String(message || '').trim();
  if (!m) return false;

  const excludes = config.comparative_follow_up_exclude_rules;
  if (testRules(m, excludes)) return false;

  const includes = config.comparative_follow_up_rules;
  if (!Array.isArray(includes) || includes.length === 0) return false;

  return testRules(m, includes);
}
