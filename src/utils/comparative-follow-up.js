/**
 * Comparative follow-up + language-gate bypass: patterns live in workflow.json under
 * analysis_agent.config (comparative_follow_up_*_rules, language_selector_bypass_rules).
 * When `config` is omitted, rules are loaded from workflow.json (cached).
 *
 * AI-powered versions added for better context awareness and multilingual support.
 */

import fs from 'fs';
import path from 'path';
import openai from '../config/openai.js';
import { getRoleConfig, AI_ROLES } from '../config/ai-registry.js';

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
 * AI-powered comparative question detection.
 * Replaces regex pattern matching with LLM interpretation.
 *
 * @param {string} userMessage - User message
 * @param {object} context - { phase, lastComparedItems }
 * @returns {Promise<object>} { isComparative, confidence, extractedBikes, attributes, reasoning }
 */
export async function detectComparativeIntent(userMessage, context = null) {
  const systemPrompt = `You are a comparative question analyzer for a motorcycle sales chatbot.

Given a user message, determine if it is a comparative question about motorcycles.
Comparative questions ask to compare two or more motorcycles on specific attributes.

Examples:
- "Compare Yamaha and Honda" -> isComparative: true
- "Which is better for city riding?" -> isComparative: false (preference question)
- "What difference between these two?" -> isComparative: true
- "Bandingkan motor dua jenama ni" (compare two brands) -> isComparative: true
- "Which one is faster?" -> isComparative: false (single-item attribute question)
- "Is the Honda or Yamaha better?" -> isComparative: true
- "Saya nak tahu perbezaan antara dua model ni" -> isComparative: true

Context: ${context ? JSON.stringify(context) : 'No prior context'}

Respond with JSON:
{
  "isComparative": true/false,
  "confidence": 0.0-1.0,
  "extractedBikes": ["bike1", "bike2"], // if identifiable
  "attributes": ["speed", "fuel economy"], // if mentioned
  "reasoning": "brief explanation"
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: getRoleConfig(AI_ROLES.ANALYZER).model || 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 200
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.warn('[comparative-follow-up] AI detection failed:', err.message);
    return { isComparative: false, confidence: 0, reasoning: err.message };
  }
}

/**
 * AI-powered comparative follow-up interpretation.
 * Determines user intent when responding to a comparison.
 *
 * @param {string} userMessage - User response message
 * @param {object} compareContext - { bikes, phase }
 * @param {string} userLanguage - Language code
 * @returns {Promise<object>} { intent, extractedAttributes, newBikeNames, confidence, reasoning }
 */
export async function interpretComparativeFollowUp(userMessage, compareContext, userLanguage = 'en') {
  const systemPrompt = `A user is responding to a comparison of motorcycles.
They previously asked to compare: ${compareContext.bikes?.join(' vs ') || 'motorcycles'}

The user said: "${userMessage}"
Language: ${userLanguage}

Interpret what the user wants:
1. Are they asking about a specific attribute (price, fuel, power)?
2. Do they want to add another bike to the comparison?
3. Are they narrowing down to one option?
4. Are they asking for a recommendation?

Respond with JSON:
{
  "intent": "attribute_comparison" | "add_bike" | "narrow_down" | "recommend" | "clarification" | "other",
  "extractedAttributes": ["price", "fuel consumption"],
  "newBikeNames": [], // if adding a bike
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: getRoleConfig(AI_ROLES.ANALYZER).model || 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 200
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.warn('[comparative-follow-up] AI interpretation failed:', err.message);
    return { intent: 'other', confidence: 0, reasoning: err.message };
  }
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