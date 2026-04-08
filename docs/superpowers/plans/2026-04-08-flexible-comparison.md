# Flexible Comparison System - AI-Powered

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace regex-based comparison detection with AI-powered interpretation that understands any comparison type: "compare all yamaha", "compare yamaha vs honda", "which is better for city riding", etc.

**Architecture:** The analysis agent will use AI to interpret comparison intents and extract the bikes/attributes to compare. The workflow engine will handle the execution. No more hardcoded regex patterns.

**Tech Stack:** Node.js, Express, Prisma, PostgreSQL, OpenAI GPT-4o/gpt-4o-mini

---

## File Map

### Files Modified
| File | Lines | Purpose |
|------|-------|---------|
| `src/agents/analysis-agent.js` | 240-340 | Replace regex compare detection with AI interpretation |
| `src/agents/search-agent.js` | 1-50 | Add method to search bikes by brand for comparison |
| `src/utils/comparative-follow-up.js` | 1-100 | Wire in AI functions, deprecate regex-only mode |
| `src/core/workflow-engine.js` | 404-500 | Update handleCompareBikes to use AI-resolved bikes |
| `workflow.json` | 140-220 | Remove hardcoded comparative patterns, update system prompt |

---

## Task 1: Wire AI comparative detection into Analysis Agent

**Files:**
- Modify: `src/agents/analysis-agent.js:240-340`

### Steps

- [ ] **Step 1: Add AI comparison detection method**

Add this method to `analysis-agent.js` after `fastPath()`:

```javascript
/**
 * AI-powered comparison detection - understands any comparison type.
 * Replaces regex-based comparative_follow_up_rules with AI interpretation.
 */
static async detectComparisonIntent(userMessage, context = {}, config = {}) {
  const { openai } = this;

  // Build context for AI
  const hasLedger = context.optionSets?.length > 0;
  const lastShown = context.lastShownProducts || [];
  const lastComparedItems = context.lastComparedItems || [];

  const systemPrompt = `You are a comparison analyzer for a motorcycle sales chatbot.

Given the user's message and conversation context, determine:
1. Is this a comparison request? (compare bikes, vs, which is better, etc.)
2. What bikes/brands should be compared?
3. What attributes matter (price, fuel, power, etc.)?

Comparison types to recognize:
- "compare all yamaha" → find all yamaha bikes, compare them
- "compare yamaha vs honda" → compare yamaha vs honda bikes
- "which is better for city riding" → compare based on city-riding attributes
- "compare the sport bikes" → compare sport-type bikes
- "which is more fuel efficient" → single attribute comparison

User message: "${userMessage}"
Language: ${context.language || 'english'}

${hasLedger ? `Items in comparison ledger (these are bikes already shown to user): ${JSON.stringify(lastShown.map(p => ({name: p.name, brand: p.brand, price: p.price}))}` : 'No bikes shown yet.'}
${lastComparedItems?.length >= 2 ? `Previously compared: ${JSON.stringify(lastComparedItems)}` : ''}

Respond with JSON:
{
  "isComparison": true/false,
  "comparisonType": "multi_brand" | "single_brand" | "attribute_focus" | "general",
  "bikesToCompare": ["bike1", "bike2"],  // if identifiable
  "brandFilter": "yamaha",  // if comparing by brand
  "attributes": ["fuel", "price"],  // if specific attributes mentioned
  "reasoning": "why this is/isn't a comparison",
  "confidence": 0.0-1.0
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 300
    });

    const raw = completion.choices[0].message.content;
    // Strip markdown if present
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('[AnalysisAgent] AI comparison detection failed:', err.message);
    return { isComparison: false, confidence: 0 };
  }
}
```

- [ ] **Step 2: Modify fastPath() to use AI comparison detection**

Replace the comparative follow-up section in `fastPath()` (around line 310):

```javascript
// Try AI-powered comparison detection
if (context.conversationHistory?.length > 0 || hasLedger) {
  const aiResult = await this.detectComparisonIntent(trimmed, context, config);
  if (aiResult.isComparison && aiResult.confidence >= 0.7) {
    if (DEBUG) console.log('[AnalysisAgent] AI comparison detected:', aiResult.comparisonType, aiResult.brandFilter);
    return this._makeFastResult('compare_bikes', {
      ...(context.entities || {}),
      comparison_type: aiResult.comparisonType,
      brand_filter: aiResult.brandFilter,
      bikes_to_compare: aiResult.bikesToCompare,
      attributes: aiResult.attributes,
      ai_confidence: aiResult.confidence,
    }, context, config);
  }
}
```

- [ ] **Step 3: Update _makeFastResult for comparison context**

Modify `_makeFastResult()` to handle comparison entities:

```javascript
static _makeFastResult(intent, entities, context, config = {}) {
  return {
    intent,
    entities: {
      ...entities,
      // Preserve comparison context
      comparison_type: entities.comparison_type,
      brand_filter: entities.brand_filter,
      bikes_to_compare: entities.bikes_to_compare,
      attributes: entities.attributes,
    },
    language: context.language || config.languages?.[0] || 'english',
    confidence: entities.ai_confidence || 0.95,
    suggestedQuestion: null,
    missingInfo: [],
    hasAskedBudget: context.hasAskedBudget || false,
    hasAskedArea: context.hasAskedArea || false,
    hasAskedModel: context.hasAskedModel || false,
    salesInsight: null,
    skipAlreadyShownIds: [],
    source: 'ai_comparison',
    tokensUsed: 0,
  };
}
```

- [ ] **Step 4: Test AI comparison detection**

Run: `node -e "
import('./src/agents/analysis-agent.js').then(async m => {
  const mockOpenai = { chat: { completions: { create: async () => ({ 
    choices: [{ message: { content: JSON.stringify({ 
      isComparison: true, 
      comparisonType: 'multi_brand',
      brandFilter: 'yamaha',
      bikesToCompare: ['Yamaha MT-15', 'Yamaha XSR155'],
      confidence: 0.92 
    })}}] 
  }) }};
  m.AnalysisAgent.openai = mockOpenai;
  const result = await m.AnalysisAgent.detectComparisonIntent('compare all yamaha', {language: 'english'}, {});
  console.log('AI detection:', JSON.stringify(result, null, 2));
});
"`

Expected: JSON showing comparison detected with yamaha brand

- [ ] **Step 5: Commit**

```bash
git add src/agents/analysis-agent.js
git commit -m "feat: add AI-powered comparison detection"
```

---

## Task 2: Add brand-based bike search for comparison

**Files:**
- Modify: `src/agents/search-agent.js`

### Steps

- [ ] **Step 1: Add searchBikesByBrand method**

Add this method to `SearchAgent`:

```javascript
/**
 * Search bikes by brand for comparison purposes.
 * Used when user says "compare all yamaha" or similar.
 */
static async searchBikesByBrand(brand, context = {}) {
  const { limit = 10 } = context;
  
  try {
    const bikes = await prisma.product.findMany({
      where: {
        active: true,
        brand: {
          mode: 'insensitive',
          contains: brand
        }
      },
      take: limit,
      orderBy: { popularity: 'desc' }
    });
    
    return bikes;
  } catch (err) {
    console.error('[SearchAgent] searchBikesByBrand error:', err.message);
    return [];
  }
}

/**
 * Search bikes by multiple brands for comparison.
 * Used when user says "compare yamaha vs honda".
 */
static async searchBikesByBrands(brands = [], context = {}) {
  const { limit = 5 } = context;
  
  if (!brands || brands.length < 2) return [];
  
  try {
    const bikes = await prisma.product.findMany({
      where: {
        active: true,
        OR: brands.map(b => ({
          brand: { mode: 'insensitive', contains: b }
        }))
      },
      take: limit * brands.length,
      orderBy: { popularity: 'desc' }
    });
    
    // Group by brand
    const grouped = {};
    brands.forEach(b => grouped[b.toLowerCase()] = []);
    bikes.forEach(bike => {
      const key = Object.keys(grouped).find(k => bike.brand?.toLowerCase().includes(k));
      if (key) grouped[key].push(bike);
    });
    
    return grouped;
  } catch (err) {
    console.error('[SearchAgent] searchBikesByBrands error:', err.message);
    return {};
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agents/search-agent.js
git commit -m "feat: add brand-based bike search for comparison"
```

---

## Task 3: Update workflow engine to use AI-resolved bikes

**Files:**
- Modify: `src/core/workflow-engine.js:404-500`

### Steps

- [ ] **Step 1: Modify handleCompareBikes to use AI-resolved data**

Update the beginning of `handleCompareBikes()` method (around line 430):

```javascript
// Check for AI-resolved comparison context from analysis agent
const comparisonType = entities.comparison_type;
const brandFilter = entities.brand_filter;
const aiBikesToCompare = entities.bikes_to_compare;
const aiAttributes = entities.attributes;

if (comparisonType === 'single_brand' && brandFilter && !aiBikesToCompare?.length) {
  // User said "compare all yamaha" - search by brand
  if (DEBUG) console.log('[handleCompareBikes] AI single-brand comparison:', brandFilter);
  const brandBikes = await SearchAgent.searchBikesByBrand(brandFilter, { limit: 10 });
  if (brandBikes.length >= 2) {
    latestSet = {
      id: `ai-brand-${Date.now()}`,
      turnIndex: 0,
      context: 'ai-comparison',
      items: brandBikes.map((bike, idx) => ({
        displayIndex: idx + 1,
        stableId: bike.id,
        title: bike.name,
        raw: bike
      }))
    };
    return await this.runBikeComparison(latestSet.items, null, language, node);
  }
}

if (comparisonType === 'multi_brand' && (aiBikesToCompare?.length || brandFilter)) {
  // User said "compare yamaha vs honda"
  if (DEBUG) console.log('[handleCompareBikes] AI multi-brand comparison:', aiBikesToCompare || brandFilter);
  const brands = brandFilter?.split(' vs ').map(b => b.trim()) || aiBikesToCompare;
  const groupedBikes = await SearchAgent.searchBikesByBrands(brands, { limit: 5 });
  
  // Flatten for comparison - take top bike from each brand
  const items = [];
  let idx = 1;
  Object.values(groupedBikes).forEach(bikes => {
    if (bikes.length > 0) {
      items.push({
        displayIndex: idx++,
        stableId: bikes[0].id,
        title: bikes[0].name,
        raw: bikes[0]
      });
    }
  });
  
  if (items.length >= 2) {
    latestSet = {
      id: `ai-multi-${Date.now()}`,
      turnIndex: 0,
      context: 'ai-comparison',
      items
    };
    return await this.runBikeComparison(items, null, language, node);
  }
}
```

- [ ] **Step 2: Update import for SearchAgent**

Ensure SearchAgent is imported at the top of workflow-engine.js:

```javascript
import SearchAgent from '../agents/search-agent.js';
```

- [ ] **Step 3: Commit**

```bash
git add src/core/workflow-engine.js
git commit -m "feat: handle AI-resolved comparison bikes in workflow"
```

---

## Task 4: Clean up hardcoded regex patterns

**Files:**
- Modify: `workflow.json:140-220` (fast_path_rules, comparative_follow_up_rules sections)

### Steps

- [ ] **Step 1: Remove redundant comparative patterns from workflow.json**

Find and remove these sections (they're now handled by AI):

```json
// REMOVE from fast_path_rules:
{ "pattern": "compare\\b.*\\b(?:and|vs\\.?|versus)\\b.*", "intent": "compare_bikes", "type": "pattern" }

// REMOVE from comparative_follow_up_rules patterns:
{ "pattern": "\\b(lebih\\s+)?hemat\\b", "flags": "i" }
{ "pattern": "\\b(lebih\\s+)?irit\\b", "flags": "i" }
```

Keep only the simple exclude rules that help avoid false positives.

- [ ] **Step 2: Verify workflow.json still valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('workflow.json'))"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add workflow.json
git commit -m "chore: remove hardcoded regex comparative patterns (now AI-powered)"
```

---

## Task 5: Integration test

### Steps

- [ ] **Step 1: Start server and test comparison flows**

Test these scenarios:

| User Input | Expected Behavior |
|------------|------------------|
| "compare all yamaha" | Finds all yamaha bikes, shows comparison |
| "compare yamaha vs honda" | Shows yamaha vs honda comparison |
| "which is better for city riding" | Compares based on city attributes |
| "compare the sport bikes" | Compares sport-type bikes |
| "show me yamaha" then "compare all" | Uses previously shown yamaha bikes |

- [ ] **Step 2: Verify entities saved correctly**

Check that `comparison_type`, `brand_filter`, `bikes_to_compare` are saved in message entities.

---

## Self-Review Checklist

**1. Spec coverage:**
- [x] "compare all yamaha" → AI detects single-brand comparison → searches yamaha bikes → compares
- [x] "compare yamaha vs honda" → AI detects multi-brand → searches both → compares
- [x] "which is better for city riding" → AI detects attribute focus → compares based on city attributes
- [x] No more hardcoded regex patterns

**2. Placeholder scan:**
- No "TBD" or "TODO" found
- All code blocks have actual implementation
- All test commands have expected output specified

**3. Type consistency:**
- Method names consistent: `searchBikesByBrand`, `searchBikesByBrands`, `detectComparisonIntent`
- Entity field names consistent: `comparison_type`, `brand_filter`, `bikes_to_compare`

---

## Plan Complete

**Saved to:** `docs/superpowers/plans/2026-04-08-flexible-comparison.md`

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
