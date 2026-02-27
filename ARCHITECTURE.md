# Sales AI Chatbot Architecture

## 🏗️ System Overview

This is an intelligent sales chatbot system built with:
- **Workflow-based architecture** - JSON-driven workflow (n8n-like)
- **NLP Processing** - OpenAI GPT-4o-mini for intent extraction
- **Smart Recommendations** - AI-powered product ranking
- **Multi-modal Support** - Text, images, voice messages
- **Agent Escalation** - Automatic handoff to human agents
- **Token Optimization** - Efficient API usage

## 📊 Architecture Diagram

```
User Message (WhatsApp/Terminal/API)
    ↓
Workflow Engine
    ↓
Message Classifier (text/image/voice)
    ↓
┌─────────────────┬──────────────┬──────────────┐
│   Text Path     │  Image Path  │  Voice Path  │
├─────────────────┼──────────────┼──────────────┤
│ NLP Processor   │ Vision API   │ Whisper API  │
│ (Intent/Entity) │ (GPT-4o)     │ (Transcribe) │
│       ↓         │      ↓       │      ↓       │
│ Intent Router   │ Image Search │ NLP Processor│
│       ↓         │      ↓       │      ↓       │
│ Product Search  │ Product Rank │ Intent Router│
│       ↓         │      ↓       │      ↓       │
│ Product Ranker  │ Format       │ Product Search│
│       ↓         │      ↓       │      ↓       │
│ Format Response │ Send         │ Product Rank │
│       ↓         │              │      ↓       │
│ Optimize        │              │ Format       │
│       ↓         │              │      ↓       │
│ Send Response   │              │ Optimize     │
│                 │              │      ↓       │
│                 │              │ Send Response│
└─────────────────┴──────────────┴──────────────┘
```

## 🔄 Workflow System

### Workflow JSON Structure

The `workflow.json` file defines the entire chatbot logic:

1. **Nodes** - Individual processing steps
2. **Routes** - Decision points and branching
3. **Templates** - Response templates
4. **Settings** - Token budgets, timeouts, etc.

### Key Workflow Nodes

1. **start** - Entry point, receives user message
2. **message_classifier** - Classifies message type (text/image/voice)
3. **nlp_processor** - Extracts intent and entities using GPT-4o-mini
4. **intent_router** - Routes to appropriate handler based on intent
5. **product_search** - Searches database for products
6. **product_ranker** - AI ranks products by relevance
7. **product_recommender** - Smart recommendations with high confidence
8. **product_response_formatter** - Formats products for WhatsApp
9. **response_optimizer** - Optimizes response for token usage
10. **agent_escalation** - Handles escalation to human agents
11. **response_sender** - Sends final response
12. **conversation_logger** - Logs conversation to database

## 🧠 NLP Processing

### Intent Classification

The system recognizes these intents:
- `greeting` - User says hello
- `product_inquiry` - User asks about products
- `product_recommendation` - User wants recommendations
- `price_inquiry` - User asks about price
- `order_status` - User checks order status
- `complaint` - User has a complaint
- `general_question` - General questions
- `goodbye` - User says goodbye
- `agent_request` - User wants human agent

### Entity Extraction

Extracts:
- `product_name` - Name of product
- `product_category` - Category (e.g., "laptops")
- `price_range` - Price range mentioned
- `features` - Features requested
- `brand` - Brand name
- `quantity` - Number of items
- `urgency` - Urgency level

## 🛍️ Product Recommendation System

### Search Strategy

1. **Database Search** - Searches products by:
   - Name (fuzzy match)
   - Description (text search)
   - Category
   - Tags
   - Active and in-stock only

2. **AI Ranking** - Uses GPT-4o-mini to rank by:
   - Exact name match
   - Category relevance
   - Feature match
   - Price appropriateness
   - User intent

3. **Confidence Scoring** - Only recommends if confidence > 0.6

### Recommendation Flow

```
User Query: "I need a laptop for gaming"
    ↓
Search Database → Find 10 products
    ↓
AI Ranking → Score each product (0-1)
    ↓
Filter by confidence > 0.6
    ↓
Return top 3 products
    ↓
Format response with images, prices, features
```

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

- **Product** - Products with embeddings for semantic search
- **User** - User profiles and preferences
- **Conversation** - Conversation logs
- **Message** - Individual messages
- **Order** - Order tracking
- **ProductView** - Analytics

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
