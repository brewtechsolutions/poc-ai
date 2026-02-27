import express from 'express';
import dotenv from 'dotenv';
import WorkflowEngine from './core/workflow-engine.js';
import prisma from './config/database.js';
import testChatRouter from './routes/test-chat.js';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public')); // Serve static files (HTML test interface)
app.use(testChatRouter);

const workflowEngine = new WorkflowEngine();

// Health check
app.get('/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'healthy', database: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'unhealthy', error: error.message });
  }
});

// WhatsApp webhook endpoint (for future integration)
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { message, from, type, mediaUrl } = req.body;

    const context = {
      user_message: message,
      metadata: {
        phone_number: from,
        message_type: type || 'text',
        media_url: mediaUrl,
        timestamp: new Date().toISOString(),
      },
    };

    const result = await workflowEngine.execute(context);
    const response = result.lastResult?.data?.finalResponse || 
                    result.lastResult?.data?.optimized ||
                    'I apologize, I couldn\'t process that request.';

    // TODO: Send response via WhatsApp
    // await whatsappClient.sendMessage(from, response);

    res.json({
      success: true,
      response,
      tokensUsed: result.tokensUsed,
      responseTime: result.responseTime,
    });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test endpoint
app.post('/api/test', async (req, res) => {
  try {
    const { message } = req.body;

    const context = {
      user_message: message,
      metadata: {
        phone_number: 'test-user',
        message_type: 'text',
        timestamp: new Date().toISOString(),
      },
    };

    const result = await workflowEngine.execute(context);
    const response = result.lastResult?.data?.finalResponse || 
                    result.lastResult?.data?.optimized ||
                    'I apologize, I couldn\'t process that request.';

    res.json({
      success: true,
      response,
      debug: {
        intent: result.lastResult?.data?.intent,
        confidence: result.lastResult?.data?.confidence,
        tokensUsed: result.tokensUsed,
        responseTime: result.responseTime,
        products: result.lastResult?.data?.products,
      },
    });
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🌐 Web Test Interface: http://localhost:${PORT}/test-chat.html`);
  console.log(`📝 API Test endpoint: POST http://localhost:${PORT}/api/test-chat`);
  console.log(`💬 Terminal test: npm run test`);
});
