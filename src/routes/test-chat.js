import express from 'express';
import WorkflowEngine from '../core/workflow-engine.js';
import { appendOptionSet } from '../utils/session-option-sets.js';
import prisma from '../config/database.js';

const router = express.Router();

// In-memory cache for non-DB session state (option sets, entities, etc.)
// This is fine for POC - these are runtime state, not conversation history
const sessionCache = new Map();

/**
 * Helper: get or create User by phoneNumber
 */
async function getOrCreateUser(phoneNumber) {
  let user = await prisma.user.findUnique({
    where: { phoneNumber },
  });

  if (!user) {
    user = await prisma.user.create({
      data: { phoneNumber },
    });
  }

  return user;
}

/**
 * Helper: get or create Conversation for a user
 */
async function getOrCreateConversation(userId) {
  // For POC, use one conversation per sessionId
  // Find the most recent conversation for this user
  let conversation = await prisma.conversation.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        userId,
        productsShown: [],
        optionSets: [],
        tokensUsed: 0,
      },
      include: {
        messages: true,
      },
    });
  }

  return conversation;
}

/**
 * Fully automated test chat endpoint
 */
router.post('/api/test-chat', async (req, res) => {
  try {
    const { message, sessionId, clearSession } = req.body;

    const currentSessionId = sessionId || `test-${Date.now()}`;
    const phoneNumber = `test-${currentSessionId}`;

    // Clear session if requested
    if (clearSession) {
      const user = await prisma.user.findUnique({ where: { phoneNumber } });
      if (user) {
        // Delete all conversations and messages (cascade)
        await prisma.conversation.deleteMany({ where: { userId: user.id } });
      }
      sessionCache.delete(currentSessionId);
      return res.json({
        success: true,
        message: 'Session cleared',
        sessionId: currentSessionId,
      });
    }

    // Get or create user and conversation
    const user = await getOrCreateUser(phoneNumber);
    const conversation = await getOrCreateConversation(user.id);

    // Get runtime session cache; hydrate optionSets / lastShown from DB when cache is cold (e.g. after restart)
    let cache = sessionCache.get(currentSessionId) || {
      language: null,
      languageLocked: false,
      lastIntent: null,
      lastEntities: {},
      lastShownProducts:
        Array.isArray(conversation.lastShownProducts) && conversation.lastShownProducts.length > 0
          ? conversation.lastShownProducts
          : null,
      optionSets: Array.isArray(conversation.optionSets) ? conversation.optionSets : [],
      activeSetId: null,
      hasAskedBudget: false,
      hasAskedArea: false,
      hasAskedModel: false,
      skipAlreadyShownIds: [],
      salesInsights: [],
      pendingCompare: null,
      lastComparedItems: null,
      totalTokens: 0,
      turnCount: 0,
      startTime: Date.now(),
    };

    if (
      conversation.entities &&
      typeof conversation.entities === 'object' &&
      Array.isArray(conversation.entities.lastComparedItems) &&
      conversation.entities.lastComparedItems.length >= 2
    ) {
      cache.lastComparedItems = conversation.entities.lastComparedItems;
    }

    cache.turnCount = (cache.turnCount ?? 0) + 1;

    // Save user message to DB
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        type: 'text',
        content: message,
        isFromUser: true,
      },
    });

    // Build full conversation history from DB messages
    const allMessages = conversation.messages || [];
    const conversationHistory = allMessages
      .map((m) => ({
        role: m.isFromUser ? 'user' : 'assistant',
        content: m.content || '',
      }))
      .filter((m) => m.content);

    // Add current user message to history
    conversationHistory.push({ role: 'user', content: message });

    // DB is source of truth for ledger state — in-memory cache can lag behind after "got others?" / multi-instance
    const dbOptionSets = Array.isArray(conversation.optionSets) ? conversation.optionSets : [];
    const dbLastShownProducts = conversation.lastShownProducts ?? null;
    if (dbOptionSets.length > 0) cache.optionSets = dbOptionSets;
    // Do not overwrite cache with [] — empty DB JSON is truthy and would wipe last search (compare-only turns)
    if (Array.isArray(dbLastShownProducts) && dbLastShownProducts.length > 0) {
      cache.lastShownProducts = dbLastShownProducts;
    }

    // `??` is wrong for [] — DB [] is not nullish, so it would beat cache and empty the list on every request
    const effectiveLastShown =
      Array.isArray(dbLastShownProducts) && dbLastShownProducts.length > 0
        ? dbLastShownProducts
        : cache.lastShownProducts ?? null;

    // Build context for workflow
    const workflowEngine = new WorkflowEngine();
    const context = {
      user_message: message,
      language: cache.language,
      languageLocked: cache.languageLocked,
      lastIntent: cache.lastIntent,
      phone_number: phoneNumber,
      conversation_id: currentSessionId,
      entities: cache.lastEntities,
      lastShownProducts: effectiveLastShown,
      optionSets: dbOptionSets.length > 0 ? dbOptionSets : (cache.optionSets ?? []),
      activeSetId: cache.activeSetId ?? null,
      hasAskedBudget: cache.hasAskedBudget || false,
      hasAskedArea: cache.hasAskedArea || false,
      hasAskedModel: cache.hasAskedModel || false,
      skipAlreadyShownIds: cache.skipAlreadyShownIds || [],
      pendingCompare: cache.pendingCompare ?? null,
      lastComparedItems: cache.lastComparedItems ?? cache.lastEntities?.lastComparedItems ?? null,
      metadata: {
        phone_number: phoneNumber,
        message_type: 'text',
        timestamp: new Date().toISOString(),
        language: cache.language,
        entities: cache.lastEntities,
        lastShownProducts: effectiveLastShown,
        optionSets: dbOptionSets.length > 0 ? dbOptionSets : (cache.optionSets ?? []),
        activeSetId: cache.activeSetId ?? null,
        lastComparedItems: cache.lastComparedItems ?? cache.lastEntities?.lastComparedItems ?? null,
      },
      // Full conversation history from DB - no slice limit
      conversationHistory,
    };

    const result = await workflowEngine.execute(context);

    if (Array.isArray(result.optionSets) && result.optionSets.length > 0) {
      cache.optionSets = result.optionSets;
    }
    if (Array.isArray(result.lastShownProducts) && result.lastShownProducts.length > 0) {
      cache.lastShownProducts = result.lastShownProducts;
    }

    const getResponseFromData = (data) => {
      if (!data) return null;
      return (
        data.finalResponse ||
        data.optimized ||
        data.response ||
        data.formatted ||
        null
      );
    };

    // Extract response
    let response = null;
    response = getResponseFromData(result.lastResult?.data);
    if (!response && result.allResults) {
      for (let i = result.allResults.length - 1; i >= 0; i--) {
        response = getResponseFromData(result.allResults[i]?.data);
        if (response) break;
      }
    }
    if (!response) {
      response = result.errors?.length > 0
        ? `I encountered an error: ${result.errors[0]}. Please try again.`
        : "I apologize, I couldn't process that request. Please try rephrasing.";
    }

    // Save bot response to DB
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        type: 'text',
        content: response,
        isFromUser: false,
        intent: result.lastResult?.data?.intent || null,
        entities: result.lastResult?.data?.entities || undefined,
        processed: true,
      },
    });

    // Update conversation metadata in DB
    // Use the *last* step that returned products so the ledger matches the most recent list shown
    // (find() alone returns the first match and can append the wrong batch to optionSets).
    // Prefer the last step that actually returned bikes — some nodes include `products: []`,
    // which would otherwise win as "last" and skip ledger / lastShown updates (breaks "compare all").
    const productSteps = (result.allResults || []).filter(
      (r) => Array.isArray(r.data?.products) && r.data.products.length > 0,
    );
    const productsFromResult = productSteps[productSteps.length - 1]?.data?.products;

    const shownIds = productsFromResult?.map((p) => p.id).filter(Boolean) || [];
    const updatedProductsShown = [...new Set([
      ...(conversation.productsShown || []),
      ...shownIds,
    ])];

    // Update runtime cache
    if (result.language) cache.language = result.language;
    if (result.languageLocked !== undefined) cache.languageLocked = result.languageLocked;
    if (result.lastIntent !== undefined) cache.lastIntent = result.lastIntent;
    if (result.hasAskedBudget !== undefined) cache.hasAskedBudget = result.hasAskedBudget;
    if (result.hasAskedArea !== undefined) cache.hasAskedArea = result.hasAskedArea;
    if (result.hasAskedModel !== undefined) cache.hasAskedModel = result.hasAskedModel;

    // Merge entities
    const analysisEntities = result.analysisEntities || {};
    const legacyEntities = result.allResults
      ?.find((r) => r.data?.entities && Object.keys(r.data.entities).length > 0)
      ?.data?.entities || {};
    const mergedEntities = { ...(cache.lastEntities || {}), ...legacyEntities, ...analysisEntities };
    if (Object.keys(mergedEntities).length > 0) cache.lastEntities = mergedEntities;

    if (result.lastComparedItems !== undefined) {
      cache.lastComparedItems = result.lastComparedItems;
      cache.lastEntities = {
        ...(cache.lastEntities || {}),
        lastComparedItems: result.lastComparedItems,
      };
    }

    // Update option sets
    if (productsFromResult && productsFromResult.length > 0) {
      const tempSession = { optionSets: cache.optionSets, activeSetId: cache.activeSetId };
      appendOptionSet(tempSession, productsFromResult, {
        turnIndex: cache.turnCount,
        context: typeof message === 'string' ? message : '',
      });
      cache.optionSets = tempSession.optionSets;
      cache.activeSetId = tempSession.activeSetId;
      cache.lastShownProducts = productsFromResult;
    }

    // Update skipAlreadyShownIds
    const updatedSkipIds = [...new Set([
      ...(cache.skipAlreadyShownIds || []),
      ...(result.skipAlreadyShownIds || []),
    ])];
    cache.skipAlreadyShownIds = updatedSkipIds;

    // Update salesInsights
    if (result.salesInsight) {
      cache.salesInsights = [...(cache.salesInsights || []), result.salesInsight].slice(-10);
    }

    cache.totalTokens = (cache.totalTokens || 0) + (result.tokensUsed || 0);

    const compareStep = (result.allResults || [])
      .slice()
      .reverse()
      .find((r) => r.data && Object.prototype.hasOwnProperty.call(r.data, 'pendingCompare'));
    if (compareStep?.data?.pendingCompare !== undefined) {
      cache.pendingCompare = compareStep.data.pendingCompare;
      if (compareStep.data.pendingCompare) {
        cache.lastEntities = {
          ...(cache.lastEntities || {}),
          pendingCompare: compareStep.data.pendingCompare,
        };
      } else if (cache.lastEntities) {
        delete cache.lastEntities.pendingCompare;
        delete cache.lastEntities.selectedRef;
      }
    } else if (result.pendingCompare !== undefined) {
      cache.pendingCompare = result.pendingCompare;
      if (result.pendingCompare) {
        cache.lastEntities = {
          ...(cache.lastEntities || {}),
          pendingCompare: result.pendingCompare,
        };
      } else if (cache.lastEntities) {
        delete cache.lastEntities.pendingCompare;
        delete cache.lastEntities.selectedRef;
      }
    } else if (result.lastIntent === 'compare_bikes' || cache.lastIntent === 'compare_bikes') {
      cache.pendingCompare = null;
      if (cache.lastEntities) {
        delete cache.lastEntities.pendingCompare;
        delete cache.lastEntities.selectedRef;
      }
    }

    sessionCache.set(currentSessionId, cache);

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        intent: result.lastIntent || result.lastResult?.data?.intent || null,
        entities: Object.keys(cache.lastEntities || {}).length > 0 ? cache.lastEntities : undefined,
        optionSets: cache.optionSets ?? [],
        lastShownProducts: cache.lastShownProducts ?? undefined,
        productsShown: updatedProductsShown,
        escalated: result.lastResult?.data?.intent === 'agent_request' || false,
        tokensUsed: (conversation.tokensUsed || 0) + (result.tokensUsed || 0),
        responseTime: result.responseTime || null,
      },
    });

    // Build messages array for response
    const updatedMessages = [
      ...allMessages.map((m) => ({
        type: m.isFromUser ? 'user' : 'bot',
        content: m.content,
        timestamp: m.createdAt,
      })),
      { type: 'user', content: message, timestamp: new Date().toISOString() },
      { type: 'bot', content: response, timestamp: new Date().toISOString() },
    ];

    res.json({
      success: true,
      sessionId: currentSessionId,
      response,
      language: result.language || cache.language,
      conversation: {
        messages: updatedMessages,
        stats: {
          totalMessages: updatedMessages.length,
          totalTokens: cache.totalTokens,
          duration: Date.now() - cache.startTime,
          language: cache.language,
        },
      },
      debug: {
        intent: result.lastResult?.data?.intent,
        confidence: result.lastResult?.data?.confidence,
        entities: result.lastResult?.data?.entities,
        products: result.lastResult?.data?.products,
        tokensUsed: result.tokensUsed,
        responseTime: result.responseTime,
        workflowSteps: result.workflowSteps || [],
        errors: result.errors || [],
        lastResultKeys: result.lastResult ? Object.keys(result.lastResult.data || {}) : [],
        salesInsight: result.salesInsight || null,
        missingInfo: result.missingInfo || [],
        analysisSource: result.analysisSource || null,
      },
    });
  } catch (error) {
    console.error('Test chat error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  }
});

/**
 * Get conversation history
 */
router.get('/api/test-chat/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const phoneNumber = `test-${sessionId}`;

  const user = await prisma.user.findUnique({
    where: { phoneNumber },
    include: {
      conversations: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  });

  if (!user || !user.conversations.length) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  const conversation = user.conversations[0];

  res.json({
    success: true,
    session: {
      id: sessionId,
      messages: conversation.messages.map((m) => ({
        type: m.isFromUser ? 'user' : 'bot',
        content: m.content,
        timestamp: m.createdAt,
      })),
      stats: {
        totalMessages: conversation.messages.length,
        totalTokens: conversation.tokensUsed,
        duration: Date.now() - new Date(conversation.createdAt).getTime(),
      },
    },
  });
});

/**
 * List all active sessions
 */
router.get('/api/test-chat', async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: {
      user: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  res.json({
    success: true,
    sessions: conversations.map((c) => ({
      id: c.user.phoneNumber.replace('test-', ''),
      messageCount: c.messages.length,
      totalTokens: c.tokensUsed,
      language: null,
      lastActivity: c.updatedAt,
      duration: Date.now() - new Date(c.createdAt).getTime(),
    })),
    count: conversations.length,
  });
});

export default router;
