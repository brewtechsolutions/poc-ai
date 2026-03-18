# MotorShop Profile

## Overview

MotorShop is a **profile** (domain configuration) for the generic AI chatbot engine. It demonstrates how to configure the engine for a specific product domain (motorcycles) without modifying any core code.

## Configuration

### Analysis Agent (`workflow.json` → `analysis_agent`)

```json
{
  "intents": [
    "greeting",
    "product_recommendation",
    "bike_recommendation",
    "more_options",
    "model_selection",
    "price_inquiry",
    "budget_question",
    "area_question",
    "model_question",
    "out_of_scope"
  ],
  "entities": [
    "budget",
    "price_range",
    "area",
    "location",
    "model",
    "brand",
    "product_type"
  ],
  "system_prompt": "You are a WhatsApp sales assistant for a Malaysian shop.\n\nScope rules (VERY IMPORTANT):\n- You ONLY sell products and related services as defined in your domain.\n- Many model names can look like other product types, but you must assume the user is asking about YOUR product category unless they clearly specify otherwise..."
}
```

### Search Configuration (`workflow.json` → `bike_search`)

```json
{
  "category": "Motorcycle",
  "search_fields": ["name", "description", "brand", "tags"],
  "filters": {
    "active": true,
    "inStock": true
  }
}
```

### Ranking Configuration (`workflow.json` → `bike_ranker`)

```json
{
  "product_type_label": "motorcycle",
  "system_prompt": "You are a sales analysis agent. Based on the conversation context and the list of candidate products, analyze the user's message..."
}
```

## Database Schema

Products are stored in the generic `Product` table with:

- `category: "Motorcycle"`
- `features` JSON containing:
  - `model`, `year`, `type`, `engineSize`, `condition`
  - `locations` (e.g. `["Puchong", "PJ", "KL"]`)
  - `specifications` (engine, fuel system, transmission, etc.)

## Templates

All response templates are in `workflow.json` → `templates`:

- `greeting` - Welcome message
- `bike_recommendation` - Product recommendations
- `clarification_questions` - Asking for missing info
- `out_of_scope` - Handling non-motorcycle queries
- etc.

All templates support multi-language (English, Malay, Chinese).

## How It Works

1. **User sends message** → `AnalysisAgent` extracts intent/entities using MotorShop-specific prompt
2. **Router** → Routes based on slots (budget/area/model) to `bike_search`
3. **Search** → Searches `Product` table with `category: "Motorcycle"` filter
4. **Ranking** → AI ranks products using generic prompt parameterized by `product_type_label: "motorcycle"`
5. **Response** → Formats using MotorShop templates

## Adding MotorShop-Specific Features

To add MotorShop-specific features:

1. **Add new intent** to `analysis_agent.config.intents`
2. **Add route** in `analysis_router.config.routes`
3. **Add handler node** in `workflow.json` nodes array
4. **Add template** in `workflow.json` templates

No code changes needed!
