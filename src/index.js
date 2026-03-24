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

function extractSavedLanguage(user) {
  const prefs = user?.preferences;
  if (!prefs || typeof prefs !== 'object') return null;
  const value = prefs.language;
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

async function saveUserLanguage(phoneNumber, language) {
  if (!phoneNumber || !language) return;
  const existingUser = await prisma.user.findUnique({
    where: { phoneNumber },
    select: { id: true, preferences: true },
  });
  const existingPreferences =
    existingUser?.preferences && typeof existingUser.preferences === 'object'
      ? existingUser.preferences
      : {};
  const nextPreferences = { ...existingPreferences, language };

  if (existingUser) {
    await prisma.user.update({
      where: { id: existingUser.id },
      data: { preferences: nextPreferences },
    });
    return;
  }

  await prisma.user.create({
    data: {
      phoneNumber,
      preferences: nextPreferences,
    },
  });
}

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
    const existingUser = from
      ? await prisma.user.findUnique({
          where: { phoneNumber: from },
          select: { preferences: true },
        })
      : null;
    const savedLanguage = extractSavedLanguage(existingUser);
    const incomingLanguage =
      typeof req.body.language === 'string' && req.body.language.trim()
        ? req.body.language.trim().toLowerCase()
        : null;
    // Once a language has been selected and saved, keep it fixed.
    const effectiveLanguage = savedLanguage || incomingLanguage || undefined;

    const context = {
      user_message: message,
      language: effectiveLanguage,
      languageLocked: !!effectiveLanguage,
      metadata: {
        phone_number: from,
        message_type: type || 'text',
        media_url: mediaUrl,
        timestamp: new Date().toISOString(),
        language: effectiveLanguage,
      },
    };

    const result = await workflowEngine.execute(context);
    const response = result.lastResult?.data?.finalResponse ||
                    result.lastResult?.data?.optimized ||
                    'I apologize, I couldn\'t process that request.';

    // TODO: Send response via WhatsApp
    // await whatsappClient.sendMessage(from, response);
    // Persist locked language per user so subsequent turns stay in the same language.
    const finalLanguage = result.language || result.lastResult?.data?.language;
    if (from && finalLanguage) {
      await saveUserLanguage(from, finalLanguage);
    }

    res.json({
      success: true,
      response,
      language: finalLanguage,
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
    const { message, language } = req.body;
    const testPhone = 'test-user';
    const existingUser = await prisma.user.findUnique({
      where: { phoneNumber: testPhone },
      select: { preferences: true },
    });
    const savedLanguage = extractSavedLanguage(existingUser);
    const incomingLanguage = typeof language === 'string' && language.trim()
      ? language.trim().toLowerCase()
      : null;
    // Keep the conversation language fixed once it's selected.
    const effectiveLanguage = savedLanguage || incomingLanguage || undefined;

    const context = {
      user_message: message,
      language: effectiveLanguage,
      languageLocked: !!effectiveLanguage,
      metadata: {
        phone_number: testPhone,
        message_type: 'text',
        timestamp: new Date().toISOString(),
        language: effectiveLanguage,
      },
    };

    const result = await workflowEngine.execute(context);
    const response = result.lastResult?.data?.finalResponse ||
                    result.lastResult?.data?.optimized ||
                    'I apologize, I couldn\'t process that request.';

    const finalLanguage = result.language || result.lastResult?.data?.language;
    if (finalLanguage) {
      await saveUserLanguage(testPhone, finalLanguage);
    }

    res.json({
      success: true,
      response,
      language: finalLanguage,
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
