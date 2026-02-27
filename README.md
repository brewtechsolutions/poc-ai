# Sales AI Chatbot

Intelligent sales chatbot with WhatsApp integration, NLP, product recommendations, and agent escalation.

## 🚀 Features

- **Smart NLP Processing** - Intent classification and entity extraction
- **Product Recommendations** - AI-powered semantic search and ranking
- **Multi-Modal Support** - Text, images, voice messages
- **Agent Escalation** - Automatic handoff to human agents
- **Token Optimization** - Efficient API usage
- **Workflow-Based** - JSON workflow for easy configuration
- **Terminal Testing** - Fast debugging without WhatsApp setup

## 📋 Prerequisites

- Node.js 18+
- PostgreSQL database (Supabase or local)
- OpenAI API key

## 🛠️ Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required variables:
- `DATABASE_URL` - PostgreSQL connection string
- `OPENAI_API_KEY` - Your OpenAI API key

### 3. Setup Database

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# (Optional) Open Prisma Studio to view data
npm run prisma:studio
```

### 4. Seed Sample Products (Optional)

Create a seed script to add sample products for testing.

## 🧪 Testing

### Terminal Test Mode (Fast Debugging)

```bash
npm run test
```

This starts an interactive terminal interface where you can test the chatbot without WhatsApp setup.

### API Test Endpoint

```bash
# Start server
npm run dev

# Test with curl
curl -X POST http://localhost:3000/api/test \
  -H "Content-Type: application/json" \
  -d '{"message": "I need a laptop"}'
```

## 📁 Project Structure

```
├── workflow.json              # Workflow configuration (n8n-like)
├── prisma/
│   └── schema.prisma          # Database schema
├── src/
│   ├── config/
│   │   ├── database.js        # Prisma client
│   │   └── openai.js          # OpenAI client & config
│   ├── core/
│   │   └── workflow-engine.js # Workflow execution engine
│   ├── test/
│   │   └── terminal-test.js   # Terminal test interface
│   └── index.js               # Express server
└── package.json
```

## 🔄 Workflow System

The chatbot uses a JSON-based workflow system (`workflow.json`) that defines:

- **Message Classification** - Text, image, voice, etc.
- **NLP Processing** - Intent extraction and entity recognition
- **Product Search** - Semantic search in database
- **Product Ranking** - AI-powered relevance scoring
- **Response Formatting** - WhatsApp-optimized responses
- **Agent Escalation** - Automatic handoff logic

### Workflow Nodes

- `start` - Entry point
- `message_classifier` - Classifies message type
- `nlp_processor` - Extracts intent and entities
- `intent_router` - Routes to appropriate handler
- `product_search` - Database search
- `product_ranker` - AI ranking
- `product_recommender` - Smart recommendations
- `agent_escalation` - Human agent handoff
- `response_sender` - Sends response

## 🎯 Usage Examples

### Terminal Test

```bash
npm run test

# Then type:
👤 You: I need a laptop for gaming
🤖 Processing...
📤 RESPONSE: Based on your needs, here are my top recommendations...
```

### API Usage

```javascript
const response = await fetch('http://localhost:3000/api/test', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'I need a laptop' })
});

const data = await response.json();
console.log(data.response);
```

## 🔧 Configuration

### Token Optimization

Edit `src/config/openai.js`:

```javascript
export const TOKEN_CONFIG = {
  MAX_TOKENS_PER_REQUEST: 500,
  TOKEN_BUDGET_PER_CONVERSATION: 2000,
  // ...
};
```

### Workflow Customization

Edit `workflow.json` to:
- Add new intents
- Modify response templates
- Adjust confidence thresholds
- Change routing logic

## 📊 Database Schema

- **Product** - Products with embeddings for semantic search
- **User** - User profiles and preferences
- **Conversation** - Conversation logs
- **Message** - Individual messages
- **Order** - Order tracking
- **KnowledgeBase** - Q&A knowledge base

## 🚧 TODO / Roadmap

- [ ] WhatsApp.js integration
- [ ] Image processing with GPT-4 Vision
- [ ] Voice message transcription
- [ ] Product embedding generation
- [ ] Conversation context management
- [ ] Agent dashboard
- [ ] Analytics dashboard
- [ ] Performance monitoring

## 📝 License

ISC
