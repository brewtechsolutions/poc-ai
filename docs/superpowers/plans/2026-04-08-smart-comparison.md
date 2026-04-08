# Smart Comparison Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the comparison feature fully dynamic — no hardcoded brands, supporting "compare all yamaha", "compare yamaha vs honda", and brand-vs-brand DB lookups.

**Architecture:** Two new `compare_scope` values (`brand_all`, `brand_vs_brand`) are extracted by the LLM via a new `brand_comparison_advisor` skill in `workflow.json`. `handleCompareBikes()` in `workflow-engine.js` acts on these scopes by filtering the current list or fetching from DB. A DB fallback is added for item-ref resolution so "yamaha vs honda" works even when neither brand appears in the shown list.

**Tech Stack:** Node.js ESM, Prisma ORM, OpenAI chat completions, workflow.json config

---

## ⚠️ Known Bug — Must Fix First (Task 0)

"compare all yamaha" currently returns ALL brands because two things intercept it before the new brand logic runs:

**Bug 1 — FastPath in `analysis-agent.js` (line ~283)**
The `compare_mode_rules` loop runs **before the LLM**. "compare all yamaha" matches `\bcompare\s+all\b` (no end-anchor) → fastPath short-circuits with `compare_scope: 'all'`. The LLM and `brand_comparison_advisor` skill **never run**, so `compare_brand` is never extracted.

**Bug 2 — `messageMatchesCompareMode()` in `workflow-engine.js` (line ~559)**
Even if the LLM did set `compare_scope: brand_all`, the `wantsCompareAll` guard calls `this.messageMatchesCompareMode(message, 'all')` which tests the raw message against the same unanchored regex — still matches "compare all yamaha" — and falls into the full-list comparison.

**Fix for both:** Anchor all "compare all" patterns with `\s*$` so "compare all yamaha" no longer matches (Task 0). Also move the `brand_all` block **before** `wantsCompareAll` in `handleCompareBikes()` as a belt-and-suspenders guard (Task 2).

---

## Files Changed

| File | Change |
|------|--------|
| `workflow.json` | **[Task 0]** Anchor compare_mode_rules regexes; **[Task 1]** add entities + `brand_comparison_advisor` skill |
| `src/core/workflow-engine.js` | **[Task 2]** brand_all block BEFORE wantsCompareAll; brand_vs_brand block; DB fallback on miss |

---

## Current Behaviour Reference

- `handleCompareBikes()` starts at line ~404 in `src/core/workflow-engine.js`
- `wantsCompareAll` check is at line ~558–562
- `resolveRef()` is defined locally inside `handleCompareBikes()` at line ~582
- `item1`/`item2` not-found return is at line ~649–660
- `resolveTwoProductsFromDb()` is at line ~368 (reused for DB fallback)
- `compare_mode_rules` fastPath loop is in `analysis-agent.js` at line ~283
- `analysis_agent` config in `workflow.json` starts at line ~62

---

## Task 0: Anchor `compare_mode_rules` patterns so "compare all yamaha" falls through to LLM

This is the root-cause fix. Without it, Tasks 1–3 have no effect.

**Files:**
- Modify: `workflow.json` (the `compare_mode_rules` array, ~line 163)

- [ ] **Step 1: Add `\s*$` end-anchor to every "compare all" pattern**

Find the `compare_mode_rules` array in `workflow.json`. It currently looks like this:

```json
"compare_mode_rules": [
  { "pattern": "\\bcompare\\s+all\\b", "flags": "i", "compare_scope": "all" },
  { "pattern": "\\bcompare\\s+everything\\b", "flags": "i", "compare_scope": "all" },
  { "pattern": "\\bcompare\\s+(them\\s+)?all\\b", "flags": "i", "compare_scope": "all" },
  { "pattern": "bandingkan\\s+semua", "flags": "i", "compare_scope": "all" },
  { "pattern": "比较全部|比较所有", "flags": "i", "compare_scope": "all" }
],
```

Replace it with (note `\\s*$` appended to every pattern):

```json
"compare_mode_rules": [
  { "pattern": "\\bcompare\\s+all\\b\\s*$", "flags": "i", "compare_scope": "all" },
  { "pattern": "\\bcompare\\s+everything\\b\\s*$", "flags": "i", "compare_scope": "all" },
  { "pattern": "\\bcompare\\s+(them\\s+)?all\\b\\s*$", "flags": "i", "compare_scope": "all" },
  { "pattern": "bandingkan\\s+semua\\s*$", "flags": "i", "compare_scope": "all" },
  { "pattern": "比较全部$|比较所有$", "flags": "i", "compare_scope": "all" }
],
```

**Why this works:** "compare all" (nothing after) → still matches → full-list compare. "compare all yamaha" → no match → falls through to LLM → LLM applies `brand_comparison_advisor` skill → extracts `compare_scope: brand_all` + `compare_brand: yamaha`.

- [ ] **Step 2: Verify JSON is still valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('workflow.json','utf8')); console.log('valid')"
```

Expected output: `valid`

- [ ] **Step 3: Quick sanity test of the regex in Node**

```bash
node -e "
const re1 = /\\bcompare\\s+all\\b\\s*$/i;
console.log('compare all        :', re1.test('compare all'));        // true
console.log('compare all yamaha :', re1.test('compare all yamaha')); // false  ← was wrong before
console.log('compare all please :', re1.test('compare all please')); // false
"
```

Expected:
```
compare all        : true
compare all yamaha : false
compare all please : false
```

- [ ] **Step 4: Commit**

```bash
git add workflow.json
git commit -m "fix: anchor compare_mode_rules regexes so brand-scoped compare falls through to LLM"
```

---

## Task 1: Add new entities and `brand_comparison_advisor` skill to `workflow.json`

**Files:**
- Modify: `workflow.json` (analysis_agent config — entities array ~line 89, skills array ~line 121, active_skills ~line 110)

- [ ] **Step 1: Add `compare_brand` and `compare_brands` to the entities array**

In `workflow.json`, find the `entities` array inside the `analysis_agent` config node (currently ends with `{ "name": "compare_scope", "type": "string" }`). Add two entries after it:

The entities array should end like this after the edit:

```json
{ "name": "compare_scope", "type": "string" },
{ "name": "compare_brand", "type": "string" },
{ "name": "compare_brands", "type": "string" }
```

- [ ] **Step 2: Add the `brand_comparison_advisor` skill object to the `skills` array**

In `workflow.json`, inside the `analysis_agent` config, find the `"skills"` array (currently contains `out_of_scope_detector`, `local_market_expert`, `budget_intelligence`). Add this object at the end of the array:

```json
{
  "name": "brand_comparison_advisor",
  "prompt": "## Skill: Brand Comparison Advisor\n- If the user says 'compare all [brand]' (e.g. 'compare all yamaha', 'bandingkan semua honda', '比较所有雅马哈'), set intent=compare_bikes, entities.compare_scope='brand_all', entities.compare_brand='<brand name only, lowercase>'.\n- If the user says '[brand] vs [brand]' or 'compare [brand] and [brand]' or '[brand] or [brand] which better' (e.g. 'yamaha vs honda', 'compare yamaha and honda', 'honda or yamaha which better', 'yamaha dengan honda'), set intent=compare_bikes, entities.compare_scope='brand_vs_brand', entities.compare_brands='<brand1>,<brand2>' (comma-separated, lowercase).\n- Never hardcode brand names — extract whatever brand the user mentions.\n- Do NOT use brand_all or brand_vs_brand when the user is comparing specific numbered items or specific model names — those are handled by the normal compare flow."
}
```

- [ ] **Step 3: Add `brand_comparison_advisor` to `active_skills`**

In `workflow.json`, find the `"active_skills"` array inside the `analysis_agent` config. Add `"brand_comparison_advisor"` at the end:

```json
"active_skills": [
  "out_of_scope_detector",
  "consultative_selling",
  "budget_intelligence",
  "local_market_expert",
  "context_memory",
  "escalation_radar",
  "objection_handler",
  "financing_advisor",
  "trade_in_specialist",
  "brand_comparison_advisor"
],
```

- [ ] **Step 4: Verify the JSON is still valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('workflow.json','utf8')); console.log('valid')"
```

Expected output: `valid`

- [ ] **Step 5: Commit**

```bash
git add workflow.json
git commit -m "feat: add brand_comparison_advisor skill and compare_brand/compare_brands entities"
```

---

## Task 2: Add `brand_all` and `brand_vs_brand` handlers in `handleCompareBikes()`

The `brand_all` block must go **before** `wantsCompareAll` — if it were after, any message that slipped past Task 0 would still be caught by the "all" scope check first.

**Files:**
- Modify: `src/core/workflow-engine.js` (inside `handleCompareBikes()`)

- [ ] **Step 1: Insert the `brand_all` and `brand_vs_brand` blocks BEFORE `wantsCompareAll`**

Find this block in `handleCompareBikes()` (around line 558):

```js
    const wantsCompareAll =
      entities.compare_scope === 'all' || this.messageMatchesCompareMode(message, 'all');
    if (wantsCompareAll && latestSet.items.length >= 2) {
      return await this.runBikeComparisonMany(latestSet.items, language, node);
    }
```

Replace it with:

```js
    // Brand-scoped compare-all: "compare all yamaha" → filter list by brand, fall back to DB.
    // IMPORTANT: this block must come before wantsCompareAll — the "all" regex is unanchored
    // in messageMatchesCompareMode and would otherwise swallow "compare all yamaha".
    const compareBrand = (entities.compare_brand || '').trim().toLowerCase();
    if (entities.compare_scope === 'brand_all' && compareBrand) {
      let brandItems = (latestSet?.items || []).filter(it => {
        const b = String(it.raw?.brand || '').toLowerCase();
        const n = String(it.raw?.name || it.title || '').toLowerCase();
        return b.includes(compareBrand) || n.includes(compareBrand);
      });
      if (brandItems.length < 2) {
        const dbProducts = await prisma.product.findMany({
          where: {
            active: true,
            inStock: true,
            brand: { contains: compareBrand, mode: 'insensitive' },
          },
          take: 8,
          orderBy: { popularity: 'desc' },
        });
        if (dbProducts.length >= 2) {
          brandItems = dbProducts.map((p, i) => ({
            displayIndex: i + 1,
            stableId: String(p.id),
            title: p.name,
            raw: p,
          }));
        }
      }
      if (brandItems.length >= 2) {
        return await this.runBikeComparisonMany(brandItems, language, node);
      }
      const brandNotFoundMsg = `Sorry, I couldn't find enough ${compareBrand} models to compare.`;
      return {
        data: { finalResponse: brandNotFoundMsg, formatted: brandNotFoundMsg, response: brandNotFoundMsg, pendingCompare: null },
        tokensUsed: 0,
        next: node.config?.next || 'response_sender',
      };
    }

    // Brand-vs-brand compare: "yamaha vs honda" → fetch top product per brand from DB.
    const compareBrandsStr = (entities.compare_brands || '').trim();
    if (entities.compare_scope === 'brand_vs_brand' && compareBrandsStr) {
      const brands = compareBrandsStr.split(',').map(b => b.trim().toLowerCase()).filter(Boolean);
      if (brands.length >= 2) {
        const brandItems = [];
        for (const brand of brands) {
          const product = await prisma.product.findFirst({
            where: {
              active: true,
              inStock: true,
              brand: { contains: brand, mode: 'insensitive' },
            },
            orderBy: { popularity: 'desc' },
          });
          if (product) {
            brandItems.push({
              displayIndex: brandItems.length + 1,
              stableId: String(product.id),
              title: product.name,
              raw: product,
            });
          }
        }
        if (brandItems.length >= 2) {
          return await this.runBikeComparisonMany(brandItems, language, node);
        }
        const bvsNotFoundMsg = `Sorry, I couldn't find products for one or more of these brands: ${brands.join(', ')}.`;
        return {
          data: { finalResponse: bvsNotFoundMsg, formatted: bvsNotFoundMsg, response: bvsNotFoundMsg, pendingCompare: null },
          tokensUsed: 0,
          next: node.config?.next || 'response_sender',
        };
      }
    }

    const wantsCompareAll =
      entities.compare_scope === 'all' || this.messageMatchesCompareMode(message, 'all');
    if (wantsCompareAll && latestSet.items.length >= 2) {
      return await this.runBikeComparisonMany(latestSet.items, language, node);
    }
```

- [ ] **Step 2: Test `brand_all` manually**

Send `"compare all yamaha"` in the chat. Expected: A comparison table of Yamaha models only.
Send `"compare all"` in the chat. Expected: Full-list comparison (unchanged).

- [ ] **Step 3: Test `brand_vs_brand` manually**

Send `"compare yamaha vs honda"` with no prior list shown. Expected: Top Yamaha vs top Honda from DB.
Send `"compare yamaha and honda"`. Expected: Same result.

- [ ] **Step 4: Commit**

```bash
git add src/core/workflow-engine.js
git commit -m "feat: add brand_all and brand_vs_brand handlers before wantsCompareAll"
```

---

## Task 3: Add DB fallback when `resolveRef()` misses both refs in current list

This fixes "yamaha vs honda" when a list IS shown but neither brand appears in it.

**Files:**
- Modify: `src/core/workflow-engine.js` (inside `handleCompareBikes()`, around line 646–660)

- [ ] **Step 1: Add DB fallback between item resolution and not-found return**

Find this block (the `item1`/`item2` section, around line 646–660):

```js
    const item1 = matches1[0] || null;
    const item2 = matches2[0] || null;

    if (!item1 || !item2 || String(item1.stableId) === String(item2.stableId)) {
      return {
        data: {
          finalResponse: notFoundMsg,
          formatted: notFoundMsg,
          response: notFoundMsg,
          pendingCompare: null,
        },
        tokensUsed: 0,
        next: node.config?.next || 'response_sender',
      };
    }
```

Replace it with:

```js
    const item1 = matches1[0] || null;
    const item2 = matches2[0] || null;

    // Both refs missed the current list → try DB brand/name lookup as fallback
    if (!item1 && !item2 && refs[0] && refs[1]) {
      const ref1Norm = WorkflowEngine.normalizeCompareRef(refs[0]);
      const ref2Norm = WorkflowEngine.normalizeCompareRef(refs[1]);
      const pair = await this.resolveTwoProductsFromDb(ref1Norm, ref2Norm);
      if (pair) {
        const tempItems = pair.map((p, i) => ({
          displayIndex: i + 1,
          stableId: String(p.id),
          title: p.name,
          raw: p,
        }));
        return await this.runBikeComparisonMany(tempItems, language, node);
      }
    }

    if (!item1 || !item2 || String(item1.stableId) === String(item2.stableId)) {
      return {
        data: {
          finalResponse: notFoundMsg,
          formatted: notFoundMsg,
          response: notFoundMsg,
          pendingCompare: null,
        },
        tokensUsed: 0,
        next: node.config?.next || 'response_sender',
      };
    }
```

- [ ] **Step 2: Test cross-list brand comparison**

With a product list already shown (e.g. from a previous search for budget bikes), send `"compare yamaha and modenas"` where neither brand appears in the shown list. Expected: Fetches one product per brand from DB and compares them.

Confirm existing behaviour is unchanged: `"compare 1 and 2"` → still compares list items 1 and 2.

- [ ] **Step 3: Commit**

```bash
git add src/core/workflow-engine.js
git commit -m "feat: add DB fallback when both compare refs miss the current list"
```

---

## Task 4: Smoke-test all comparison scenarios end-to-end

**Files:** None changed — verification only.

- [ ] **Step 1: Start the dev server**

```bash
node src/index.js
```

- [ ] **Step 2: Run through each scenario and confirm expected output**

| Message | Expected behaviour |
|---|---|
| `compare all` | Compares every item in the current shown list |
| `compare all yamaha` | Compares Yamaha models only (from list if available, else DB) |
| `compare all honda` | Compares Honda models only |
| `compare yamaha vs honda` | Fetches top Yamaha and top Honda from DB, compares them |
| `compare yamaha and honda` | Same as above |
| `compare 1 and 2` | Compares list items 1 and 2 (unchanged) |
| `compare modenas and honda` | Works even with no list shown (DB lookup path) |
| `which is better yamaha or honda` | compare_bikes intent, brand_vs_brand scope |
| `bandingkan semua yamaha` | Malay: brand_all scope, Yamaha only |

- [ ] **Step 3: Commit if any minor fixes were needed**

```bash
git add -A
git commit -m "chore: verify smart comparison smoke tests pass"
```

---

## Verification Summary

After all tasks complete:

1. `"compare all yamaha"` returns **Yamaha-only** comparison (the original bug is fixed)
2. `"compare all"` (no brand) still returns full-list comparison
3. `"compare yamaha vs honda"` fetches one representative per brand from DB
4. `"compare 1 and 2"` still works unchanged
5. No brand names are hardcoded in any JS file
6. Invalid/unknown brands return a friendly not-found message
