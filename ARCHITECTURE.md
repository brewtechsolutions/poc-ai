# Sales AI Chatbot Architecture (MotorShop Example)

## 🏗️ System Overview

This project is an **AI-first, workflow-driven sales chatbot**. The current example is a **MotorShop 2nd-hand bike assistant**, but the core architecture is **generic**:

- **JSON workflow (`workflow.json`)** drives all logic (similar to n8n)  
- **Workflow engine (`workflow-engine.js`)** is generic; it just executes the JSON  
- **NLP**: OpenAI `gpt-4o-mini` for language detection, intent + entity extraction  
- **Product search**: Prisma + PostgreSQL against a **generic `Product` table**  
- **AI ranking**: GPT-based product ranking using context (budget, area, model, etc.)  
- **Multi-modal**: hooks for image (Vision) and voice (Whisper) flows  
- **Agent escalation**: routes to human when confidence is low or user asks  
- **Token optimization**: small prompts, strict temperatures, response optimizer  

The MotorShop use case is implemented purely via:

- Seed data in `Product` (`category: "Motorcycle"`, features in JSON)  
- Domain prompts + templates in `workflow.json` (no motorcycle-specific logic in JS)

## 📊 High-Level Flow

```
User Message (WhatsApp / Web UI / API)
    ↓
Express API (`/api/test-chat`) + Session Manager
    ↓
WorkflowEngine.execute(context)
    ↓
start → message_classifier → language_detector
    ↓
intent_router
    ↓
┌───────────────────────────────────────────────────────┐
│ greeting               → greeting_handler            │
│ bike/search intents    → bike_search → bike_ranker   │
│ questions (budget/area)→ budget/area/model handlers  │
│ price/spec/test-ride   → price/spec/test_ride nodes  │
│ complaint/agent        → agent_escalation            │
│ fallback               → clarification_handler       │
└───────────────────────────────────────────────────────┘
    ↓
response_optimizer → response_sender → conversation_logger → end
```

The **web test UI** (`public/test-chat.html`) talks to `/api/test-chat`, maintains a session, and renders:

- User/bot messages with preserved line breaks  
- Debug info (intent, confidence, tokens, workflow steps, errors)

## 🔄 Workflow System

### Workflow JSON Structure

The `workflow.json` file defines:

1. **Nodes** – steps like `language_detector`, `intent_router`, `bike_search`, `bike_ranker`, `bike_response_formatter`, `clarification_handler`, `agent_escalation`, etc.  
2. **Routes** – intent-based routing in `intent_router` and `next` links between nodes.  
3. **Templates** – multi-language responses (`greeting`, `bike_recommendation`, `clarification_questions`, `agent_transfer`, etc.).  
4. **Settings** – model names, temperatures, token limits, and small control flags per node.

### Key Workflow Nodes (current MotorShop flow)

1. **start** – Trigger node, receives the raw user message + metadata.  
2. **message_classifier** – Classifies message type (`text` / `image` / `voice`).  
3. **language_detector** – Single NLP node that:
   - Detects language (Malay / Chinese / English)  
   - Extracts `intent`, `entities`, and `confidence` using `gpt-4o-mini`  
4. **intent_router** – Routes based on `intent`:
   - `greeting` → `greeting_handler`  
   - `search_motorcycle` / `inquire_about_motorcycle` → `bike_search`  
   - `bike_inquiry` / `bike_recommendation` → `context_collector`  
   - `price_inquiry` → `price_lookup`  
   - `budget_question`, `area_question`, `model_question` → respective handlers  
   - `complaint` / `agent_request` → `agent_escalation`  
   - `goodbye` → `goodbye_handler`  
   - Fallback → `clarification_handler`
5. **context_collector** – ML node that analyses what’s missing (budget, area, model) and either:
   - Sends user to `smart_question_generator` (to ask for missing info), or  
   - Goes straight to `bike_search` when info is complete.
6. **smart_question_generator → question_formatter** – Asks for missing info using a **standardized, numbered format** (budget / area / model) in the user’s language.  
7. **bike_search** – Generic DB search over `Product`:
   - Uses text query + entities (budget, model, brand, type, area)  
   - Filters `active && inStock` and `category: "Motorcycle"`  
   - Applies area filter via `features.locations`, but falls back gracefully if it would remove all results.  
8. **bike_ranker** – ML node calling `gpt-4o-mini` to rank the found products:
   - Considers budget, area, model, type, popularity, and user intent  
   - Returns `products` with `relevance_score` and reasoning.  
9. **bike_response_formatter** – Formats top products into a WhatsApp-style list:
   - Multi-language template (`bike_recommendation`)  
   - Numbered items, price, engine size, type, locations, stock status.  
10. **clarification_handler** – When intent is unknown or low-confidence, sends a **clear, structured prompt** asking user for:
    - `Budget (RM)`  
    - `Area / Location`  
    - `Preferred model / brand (optional)`  
    with example reply in each language.  
11. **agent_escalation** – Generates an “I’m connecting you to an agent” message and then routes to `response_sender`.  
12. **response_optimizer** – Cleans up whitespace and ensures response stays within a rough token budget.  
13. **response_sender** – Final action node; surfaces the chosen text back to the API/UI.  
14. **conversation_logger** – Logs the conversation and **preserves the final response** so the API can always return it.

## 🧠 NLP Processing

### Intent Classification

The `language_detector` node currently focuses on motorcycle sales intents:

- `greeting` – User says hello / starts conversation  
- `bike_inquiry` – General questions about bikes (availability, types, etc.)  
- `bike_recommendation` – User wants “best bike” suggestion  
- `search_motorcycle` / `inquire_about_motorcycle` – Free-form search queries  
- `price_inquiry` – Ask about price / installments  
- `budget_question` / `area_question` / `model_question` – Follow-up questions  
- `specification_question` – Ask about specs (cc, type, features)  
- `test_ride_request` – Request to view / test ride  
- `financing_question` – Loan/instalment questions  
- `trade_in_question` – Trade-in bike questions  
- `complaint` – Complaints or dissatisfaction  
- `agent_request` – Explicit “talk to human”  
- `goodbye` – End of conversation

These are **configurable in `workflow.json`** and can be changed without touching JS.

### Entity Extraction

The same node extracts entities like:

- `budget` / `price_range` – e.g. “below 5k”, “RM 3,000 – 5,000”  
- `area` / `location` – e.g. Puchong, PJ, KL, Bahau  
- `model` / `brand` – e.g. Ego S, Y15ZR, Honda, Yamaha  
- `cc` / `engine size` – e.g. 110cc, 150cc  
- `type` – scooter, kapcai, sport, etc.  
- `condition` – new / used / recon  
- `urgency` – how urgent the need is

## 🛍️ Product Recommendation System

### Search Strategy (generic Product model)

1. **Database search (`bike_search` / `semantic_search`)**  
   - Queries the `Product` table by:
     - `name` (contains, case-insensitive)  
     - `description`  
     - `brand`  
     - `category` / `subcategory`  
     - `tags` (array overlap)  
   - Filters:
     - `active = true`, `inStock = true`  
     - Optional `category` filter (e.g. `"Motorcycle"`)  
     - Optional budget filter (price `<= budget`)  
     - Optional loose area filter via `features.locations` (but falls back if no matches).  

2. **AI ranking (`bike_ranker` ML node)**  
   - Uses `gpt-4o-mini` with:
     - User query  
     - Extracted entities (budget, area, model, type)  
     - A list of candidate products (name, price, type, locations, etc.)  
   - Returns:
     - `products`: array with `relevance_score` and reasoning  
     - `overall_reasoning` and `confidence`  

3. **Formatting (`bike_response_formatter`)**  
   - Takes the **top N** ranked products and renders:
     - Numbered list with name/model  
     - Description  
     - Price + currency  
     - Engine size, type, and locations (if present in `features`)  
   - Uses a multi-language `bike_recommendation` template.

## 🖼️ Image Processing

### Vision API Integration

1. **Image Analysis** - Uses GPT-4o Vision to:
   - Identify product name
   - Detect category
   - Extract brand
   - Estimate price range
   - Read visible text

2. **Product Search** - Uses extracted info to search database

3. **Recommendation** - Ranks and recommends matching products

## 🎤 Voice Processing

### Whisper Integration

1. **Transcription** - Converts voice to text using Whisper
2. **Language Detection** - Auto-detects language
3. **NLP Processing** - Processes transcribed text normally

## 🚨 Agent Escalation

### Escalation Triggers

- Confidence < 0.5
- Intent is "complaint"
- Intent is "agent_request"
- Complex query (multiple intents)
- User insists on agent

### Escalation Flow

```
Low Confidence / Complaint / Agent Request
    ↓
Agent Escalation Node
    ↓
Assign to Available Agent
    ↓
Transfer Context
    ↓
Notify Agent
    ↓
Send Transfer Message to User
```

## 💾 Database Schema

### Key Tables

- **Product** – Generic products table (used here for motorcycles):
  - `category` / `subcategory` (e.g. `"Motorcycle"`, `"Scooter"`, `"Kapcai"`)  
  - `features` JSON for flexible fields:
    - `model`, `year`, `type`, `engineSize`, `condition`  
    - `locations` (e.g. `["Puchong", "PJ", "KL"]`)  
    - `specifications` (engine, fuel system, transmission, etc.)  
- **User** – User profiles, preferences, and history  
- **Conversation** – Per-user conversation logs + stats  
- **Message** – Individual messages within conversations  
- **Order / OrderItem** – Basic order tracking (for future checkout flows)  
- **ProductView** – Product analytics (views per user/product)

### Relationships

```
User
  ├── Conversations (1:N)
  ├── Orders (1:N)
  └── ProductViews (1:N)

Conversation
  └── Messages (1:N)

Order
  └── OrderItems (1:N)
      └── Product (N:1)
```

## ⚡ Performance Optimization

### Token Optimization

1. **Strict Temperature** - 0.2 for classification, 0.3 for recommendations
2. **Token Budgets** - Max 500 per request, 2000 per conversation
3. **Response Compression** - Removes redundancy
4. **Caching** - Caches common queries

### Performance Features

- **Parallel Processing** - Multiple operations in parallel
- **Async Operations** - Non-blocking I/O
- **Connection Pooling** - Database connection reuse
- **Response Caching** - Cache frequent responses

## 🔐 Security Considerations

1. **API Keys** - Stored in environment variables
2. **Input Validation** - All inputs validated
3. **SQL Injection** - Prisma ORM prevents SQL injection
4. **Rate Limiting** - (To be implemented)
5. **Authentication** - (To be implemented for API)

## 📈 Monitoring & Analytics

### Tracked Metrics

- Token usage per conversation
- Response time
- Intent distribution
- Product views
- Escalation rate
- User satisfaction (future)

### Logging

- All conversations logged to database
- Intent and entities stored
- Products shown tracked
- Errors logged with stack traces

## 🚀 Future Enhancements

1. **WhatsApp Integration** - Full WhatsApp.js integration
2. **Embeddings** - Vector embeddings for semantic search
3. **User Preferences** - Learn from user history
4. **A/B Testing** - Test different recommendation strategies
5. **Analytics Dashboard** - Visual analytics
6. **Agent Dashboard** - Interface for human agents
7. **Multi-language** - Support multiple languages
8. **Voice Responses** - Text-to-speech for responses

## 🔧 Configuration

### Environment Variables

- `DATABASE_URL` - PostgreSQL connection
- `OPENAI_API_KEY` - OpenAI API key
- `MAX_TOKENS_PER_REQUEST` - Token limit per request
- `TOKEN_BUDGET_PER_CONVERSATION` - Total budget per conversation
- `ENABLE_CACHING` - Enable/disable caching

### Workflow Customization

Edit `workflow.json` to:
- Add new intents
- Modify confidence thresholds
- Change routing logic
- Update response templates
- Add new nodes

## 📚 Code Structure

```
src/
├── config/
│   ├── database.js      # Prisma client
│   └── openai.js        # OpenAI client & config
├── core/
│   └── workflow-engine.js  # Workflow execution
├── utils/
│   ├── product-recommender.js  # Smart recommendations
│   ├── image-processor.js      # Image analysis
│   └── voice-processor.js       # Voice transcription
├── test/
│   └── terminal-test.js        # Terminal testing
└── index.js                    # Express server
```

## 🎯 Key Design Decisions

1. **Workflow-Based** - Easy to modify without code changes
2. **Modular** - Each utility is independent
3. **Token-Conscious** - Optimized for cost efficiency
4. **Error-Resilient** - Graceful error handling
5. **Extensible** - Easy to add new features
