# Smart Comparison Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the comparison feature fully dynamic — no hardcoded brands, supporting "compare all yamaha", "compare yamaha vs honda", and brand-vs-brand DB lookups.

**Architecture:** Two new `compare_scope` values (`brand_all`, `brand_vs_brand`) are extracted by the LLM via a new `brand_comparison_advisor` skill in `workflow.json`. `handleCompareBikes()` in `workflow-engine.js` acts on these scopes by filtering the current list or fetching from DB. A DB fallback is added for item-ref resolution so "yamaha vs honda" works even when neither brand appears in the shown list.

**Tech Stack:** Node.js ESM, Prisma ORM, OpenAI chat completions, workflow.json config

---

## Files Changed

| File | Change |
|------|--------|
| `workflow.json` | Add `compare_brand` + `compare_brands` entities; add `brand_comparison_advisor` skill; add it to `active_skills` |
| `src/core/workflow-engine.js` | Add `brand_all` and `brand_vs_brand` handling blocks in `handleCompareBikes()`; add DB fallback after `resolveRef()` misses |

---

## Current Behaviour Reference

- `handleCompareBikes()` is at line ~404 in `src/core/workflow-engine.js`
- `wantsCompareAll` check is at line ~558–562
- `resolveRef()` is defined locally inside `handleCompareBikes()` at line ~582
- `item1`/`item2` not-found return is at line ~649–660
- `parseCompareRefs()` is at line ~871
- `resolveTwoProductsFromDb()` is at line ~368 (already handles DB brand lookup — we reuse it)
- `analysis_agent` config is in `workflow.json` starting at line ~62

---

## Task 1: Add new entities and `brand_comparison_advisor` skill to `workflow.json`

**Files:**
- Modify: `workflow.json` (analysis_agent config — entities array ~line 89, skills array ~line 121, active_skills ~line 110)

- [ ] **Step 1: Add `compare_brand` and `compare_brands` to the entities array**

In `workflow.json`, find the `entities` array inside the `analysis_agent` config node (currently ends with `{ "name": "compare_scope", "type": "string" }`). Add two entries after it:

```json
{ "name": "compare_brand", "type": "string" },
{ "name": "compare_brands", "type": "string" }
```

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

In `workflow.json`, find the `"active_skills"` array inside the `analysis_agent` config. It currently ends with `"trade_in_specialist"`. Add `"brand_comparison_advisor"` at the end:

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

## Task 2: Handle `brand_all` scope in `handleCompareBikes()`

**Files:**
- Modify: `src/core/workflow-engine.js` (inside `handleCompareBikes()`, after line ~562)

- [ ] **Step 1: Insert the `brand_all` handler block after the `wantsCompareAll` block**

In `src/core/workflow-engine.js`, find this block (around line 558–562):

```js
    const wantsCompareAll =
      entities.compare_scope === 'all' || this.messageMatchesCompareMode(message, 'all');
    if (wantsCompareAll && latestSet.items.length >= 2) {
      return await this.runBikeComparisonMany(latestSet.items, language, node);
    }
```

Add the following block **immediately after** it (before the `matchesComparativeFollowUp` line):

```js
    // Brand-scoped compare-all: "compare all yamaha" → filter list by brand, fall back to DB
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
      // Not enough results for that brand
      const brandNotFoundMsg = `Sorry, I couldn't find enough ${compareBrand} models to compare.`;
      return {
        data: { finalResponse: brandNotFoundMsg, formatted: brandNotFoundMsg, response: brandNotFoundMsg, pendingCompare: null },
        tokensUsed: 0,
        next: node.config?.next || 'response_sender',
      };
    }
```

- [ ] **Step 2: Manually test with a Node REPL or by running the dev server**

Send the message `"compare all yamaha"` in the chat. Expected: A comparison table of Yamaha models from the DB or list.

- [ ] **Step 3: Commit**

```bash
git add src/core/workflow-engine.js
git commit -m "feat: handle compare_scope=brand_all in handleCompareBikes"
```

---

## Task 3: Handle `brand_vs_brand` scope in `handleCompareBikes()`

**Files:**
- Modify: `src/core/workflow-engine.js` (immediately after the `brand_all` block added in Task 2)

- [ ] **Step 1: Insert the `brand_vs_brand` handler block**

Directly after the closing `}` of the `brand_all` block you added in Task 2, add:

```js
    // Brand-vs-brand compare: "yamaha vs honda" → fetch top product per brand from DB
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
        const missingBrands = brands.filter(
          (b, i) => !brandItems[i]
        );
        const bvsNotFoundMsg = `Sorry, I couldn't find products for: ${missingBrands.join(', ')}.`;
        return {
          data: { finalResponse: bvsNotFoundMsg, formatted: bvsNotFoundMsg, response: bvsNotFoundMsg, pendingCompare: null },
          tokensUsed: 0,
          next: node.config?.next || 'response_sender',
        };
      }
    }
```

- [ ] **Step 2: Test brand-vs-brand manually**

Send `"compare yamaha vs honda"` in the chat (with no existing list shown). Expected: A comparison of the most popular Yamaha model vs the most popular Honda model from the DB.

Also test `"compare yamaha and honda"` — should produce the same result.

- [ ] **Step 3: Commit**

```bash
git add src/core/workflow-engine.js
git commit -m "feat: handle compare_scope=brand_vs_brand in handleCompareBikes"
```

---

## Task 4: Add DB fallback when `resolveRef()` misses both refs in current list

This fixes "yamaha vs honda" when a product list IS shown but neither brand name appears as an item in the list.

**Files:**
- Modify: `src/core/workflow-engine.js` (inside `handleCompareBikes()`, around line 646–660)

- [ ] **Step 1: Add DB fallback between item resolution and not-found return**

Find this code block (around line 646–660 in `handleCompareBikes()`):

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

With a product list already shown (e.g. from a previous search), send `"compare yamaha and modenas"` where neither brand appears in the shown list. Expected: Fetches one product per brand from DB and compares them.

Also confirm existing behaviour still works: `"compare 1 and 2"` → compares items 1 and 2 from the list (unchanged).

- [ ] **Step 3: Commit**

```bash
git add src/core/workflow-engine.js
git commit -m "feat: add DB fallback when both compare refs miss the current list"
```

---

## Task 5: Smoke-test all comparison scenarios end-to-end

**Files:** None changed — verification only.

- [ ] **Step 1: Start the dev server**

```bash
node src/index.js
```

Or however you normally run the local server (check `package.json` scripts).

- [ ] **Step 2: Run through each scenario**

Use the test chat route or WhatsApp simulator. Test each message and confirm the expected output:

| Message | Expected behaviour |
|---|---|
| `compare all` | Compares every item in the current shown list |
| `compare all yamaha` | Compares all Yamaha models (from list if available, else DB) |
| `compare yamaha vs honda` | Fetches top Yamaha and top Honda from DB and compares |
| `compare yamaha and honda` | Same as above |
| `compare 1 and 2` | Compares items 1 and 2 from shown list (unchanged) |
| `compare modenas and honda` | Works even when no list shown (resolveTwoProductsFromDb path) |
| `which is better yamaha or honda` | compare_bikes intent, brand_vs_brand scope |
| `bandingkan semua yamaha` | Malay: compare all yamaha (brand_all scope) |

- [ ] **Step 3: Final commit (no code changes expected — add only if minor fixes needed)**

```bash
git add -A
git commit -m "chore: verify smart comparison smoke tests pass"
```

---

## Verification Summary

After all tasks complete, these are the key assertions:

1. No brand names are hardcoded anywhere in JS files — all come from DB or user message
2. `"compare all yamaha"` returns a Yamaha-only comparison table
3. `"compare yamaha vs honda"` returns a cross-brand comparison even with no prior list
4. `"compare 1 and 2"` still works as before
5. `"compare all"` still works as before (full list)
6. Invalid brands return a friendly not-found message (not a crash)
