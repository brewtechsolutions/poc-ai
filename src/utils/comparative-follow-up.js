/**
 * Comparative follow-up + language-gate bypass: patterns live in workflow.json under
 * analysis_agent.config (comparative_follow_up_*_rules, language_selector_bypass_rules).
 * When `config` is omitted, rules are loaded from workflow.json (cached).
 */

import fs from 'fs';
import path from 'path';

let cachedAnalysisConfig = null;

export function getAnalysisAgentConfigFromWorkflow() {
  if (cachedAnalysisConfig) return cachedAnalysisConfig;
  try {
    const workflowPath = path.resolve(process.cwd(), 'workflow.json');
    const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));
    const node = workflow.workflow?.nodes?.find(n => n.id === 'analysis_agent');
    cachedAnalysisConfig = node?.config || {};
  } catch (err) {
    console.warn('[comparative-follow-up] Could not load workflow.json:', err.message);
    cachedAnalysisConfig = {};
  }
  return cachedAnalysisConfig;
}

function resolveAnalysisConfig(config) {
  const c = config && typeof config === 'object' ? config : null;
  if (c && Array.isArray(c.comparative_follow_up_rules) && c.comparative_follow_up_rules.length > 0) {
    return c;
  }
  return getAnalysisAgentConfigFromWorkflow();
}

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
 * @param {object} [config] - analysis_agent node config (optional; loads from disk if rules missing)
 * @returns {boolean}
 */
export function matchesComparativeFollowUp(message, config) {
  const m = String(message || '').trim();
  if (!m) return false;

  const cfg = resolveAnalysisConfig(config);

  const excludes = cfg.comparative_follow_up_exclude_rules;
  if (testRules(m, excludes)) return false;

  const includes = cfg.comparative_follow_up_rules;
  if (!Array.isArray(includes) || includes.length === 0) return false;

  return testRules(m, includes);
}

/**
 * Skip "pick language 1/2/3" when the user is clearly asking about products, not choosing UI language.
 * Uses workflow rules only (no hardcoded phrase lists in JS).
 *
 * @param {string} message
 * @param {object} [config] - analysis_agent config; loads from workflow.json if needed
 * @returns {boolean}
 */
export function shouldBypassLanguageGate(message, config) {
  const m = String(message || '').trim();
  if (!m) return false;

  const cfg = resolveAnalysisConfig(config);

  if (matchesComparativeFollowUp(m, cfg)) return true;

  if (testRules(m, cfg.language_selector_bypass_rules)) return true;

  return false;
}
