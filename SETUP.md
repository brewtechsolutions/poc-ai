# Quick Setup Guide

## 🚀 Quick Start (5 minutes)

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Environment

Create `.env` file:

```bash
cp .env.example .env
```

Edit `.env` and add:
- `DATABASE_URL` - Your PostgreSQL connection string (Supabase or local)
- `OPENAI_API_KEY` - Your OpenAI API key

### 3. Setup Database

```bash
# Generate Prisma client
npm run prisma:generate

# Create database tables
npm run prisma:migrate

# (Optional) Seed sample products
npm run seed
```

### 4. Test in Terminal

```bash
npm run test
```

Type messages like:
- "I need a laptop"
- "Show me gaming laptops"
- "What's the price of MacBook Pro?"

### 5. Start API Server

```bash
npm run dev
```

Test with curl:
```bash
curl -X POST http://localhost:3000/api/test \
  -H "Content-Type: application/json" \
  -d '{"message": "I need a laptop"}'
```

## 📋 Database Setup

### Supabase Setup

1. Create a new Supabase project
2. Get your connection string from Settings → Database
3. Add to `.env`:
   ```
   DATABASE_URL="postgresql://postgres:[password]@[host]:5432/postgres"
   ```

### Local PostgreSQL Setup

1. Install PostgreSQL
2. Create database:
   ```sql
   CREATE DATABASE sales_chatbot;
   ```
3. Add to `.env`:
   ```
   DATABASE_URL="postgresql://user:password@localhost:5432/sales_chatbot"
   ```

## 🧪 Testing

### Terminal Test Mode

Fast debugging without WhatsApp:

```bash
npm run test
```

Features:
- Interactive chat interface
- Debug mode (set `DEBUG=true` in `.env`)
- Real-time workflow execution
- Token usage tracking

### API Testing

```bash
# Start server
npm run dev

# Test endpoint
curl -X POST http://localhost:3000/api/test \
  -H "Content-Type: application/json" \
  -d '{"message": "I need a laptop for gaming"}'
```

## 🔧 Configuration

### Token Optimization

Edit `src/config/openai.js`:

```javascript
export const TOKEN_CONFIG = {
  MAX_TOKENS_PER_REQUEST: 500,        // Max tokens per API call
  TOKEN_BUDGET_PER_CONVERSATION: 2000, // Total budget per conversation
  // ...
};
```

### Workflow Customization

Edit `workflow.json` to:
- Modify intents
- Change confidence thresholds
- Add new routes
- Customize response templates

## 📊 Sample Products

After running `npm run seed`, you'll have:
- MacBook Pro 16" M3 Max
- Gaming Laptop RTX 4080
- Wireless Bluetooth Headphones
- Smartphone Pro Max
- Mechanical Gaming Keyboard
- 4K Ultra HD Smart TV

## 🐛 Troubleshooting

### Database Connection Error

- Check `DATABASE_URL` in `.env`
- Ensure PostgreSQL is running
- Verify credentials

### OpenAI API Error

- Check `OPENAI_API_KEY` in `.env`
- Verify API key is valid
- Check API quota/balance

### Prisma Errors

```bash
# Regenerate Prisma client
npm run prisma:generate

# Reset database (WARNING: deletes data)
npm run prisma:migrate reset
```

## 📚 Next Steps

1. ✅ Test in terminal mode
2. ✅ Verify product recommendations work
3. ✅ Test API endpoints
4. 🔄 Integrate WhatsApp.js (coming soon)
5. 🔄 Add image/voice processing
6. 🔄 Setup agent dashboard

## 💡 Tips

- Use `DEBUG=true` in `.env` for detailed logs
- Check `workflow.json` to understand the flow
- Monitor token usage in responses
- Test with various queries to see NLP in action
