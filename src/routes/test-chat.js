import express from 'express';
import WorkflowEngine from '../core/workflow-engine.js';
import prisma from '../config/database.js';

const router = express.Router();

// In-memory session storage for testing (use Redis/DB in production)
const sessions = new Map();

/**
 * Fully automated test chat endpoint
 * Maintains conversation state and shows full flow
 */
router.post('/api/test-chat', async (req, res) => {
  try {
    const { message, sessionId, clearSession } = req.body;
    
    // Generate or use existing session
    const currentSessionId = sessionId || `test-${Date.now()}`;
    
    // Clear session if requested
    if (clearSession) {
      sessions.delete(currentSessionId);
      return res.json({
        success: true,
        message: 'Session cleared',
        sessionId: currentSessionId,
      });
    }

    // Get or create session
    let session = sessions.get(currentSessionId);
    if (!session) {
      session = {
        id: currentSessionId,
        phoneNumber: `test-${currentSessionId}`,
        messages: [],
        startTime: Date.now(),
        totalTokens: 0,
      };
      sessions.set(currentSessionId, session);
    }

    // Add user message to session
    const userMessage = {
      type: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };
    session.messages.push(userMessage);

    // Execute workflow
    const workflowEngine = new WorkflowEngine();
    const context = {
      user_message: message,
      phone_number: session.phoneNumber,
      conversation_id: currentSessionId,
      metadata: {
        phone_number: session.phoneNumber,
        message_type: 'text',
        timestamp: new Date().toISOString(),
      },
      conversationHistory: session.messages.slice(-5).map(m => ({
        role: m.type === 'user' ? 'user' : 'assistant',
        content: m.content,
      })),
    };

    const result = await workflowEngine.execute(context);
    
    // Extract response - check multiple sources
    let response = null;
    
    // Priority 1: Check last result (action node should have finalResponse)
    if (result.lastResult?.data?.finalResponse) {
      response = result.lastResult.data.finalResponse;
    }
    
    // Priority 2: Check all results in reverse order
    if (!response && result.allResults) {
      for (let i = result.allResults.length - 1; i >= 0; i--) {
        const resultData = result.allResults[i]?.data;
        if (resultData) {
          response = resultData.finalResponse || 
                     resultData.optimized ||
                     resultData.response ||
                     resultData.formatted;
          if (response) break;
        }
      }
    }
    
    // Priority 3: Check workflow steps
    if (!response && result.workflowSteps) {
      for (let i = result.workflowSteps.length - 1; i >= 0; i--) {
        // The workflowSteps might have stored data differently
        // Check if we can access the actual result
        const step = result.workflowSteps[i];
        // Note: workflowSteps only store metadata, not full data
      }
    }
    
    // Priority 4: Check lastResult for any response field
    if (!response && result.lastResult?.data) {
      response = result.lastResult.data.optimized ||
                 result.lastResult.data.response ||
                 result.lastResult.data.formatted;
    }
    
    // Priority 5: Error handling
    if (!response) {
      if (result.errors && result.errors.length > 0) {
        response = `I encountered an error: ${result.errors[0]}. Please try again or contact support.`;
      } else {
        // Last resort - this shouldn't happen if workflow is working
        response = 'I apologize, I couldn\'t process that request. Please try rephrasing your question.';
        console.error('⚠️ No response found in workflow result:', {
          hasLastResult: !!result.lastResult,
          lastResultKeys: result.lastResult?.data ? Object.keys(result.lastResult.data) : [],
          allResultsCount: result.allResults?.length || 0,
        });
      }
    }

    // Add bot response to session
    const botMessage = {
      type: 'bot',
      content: response,
      timestamp: new Date().toISOString(),
      debug: {
        intent: result.lastResult?.data?.intent,
        confidence: result.lastResult?.data?.confidence,
        entities: result.lastResult?.data?.entities,
        products: result.lastResult?.data?.products,
        tokensUsed: result.tokensUsed,
        responseTime: result.responseTime,
      },
    };
    session.messages.push(botMessage);
    session.totalTokens += result.tokensUsed || 0;
    session.lastActivity = Date.now();

    // Prepare response with full conversation
    res.json({
      success: true,
      sessionId: currentSessionId,
      response: response,
      conversation: {
        messages: session.messages,
        stats: {
          totalMessages: session.messages.length,
          totalTokens: session.totalTokens,
          duration: Date.now() - session.startTime,
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
router.get('/api/test-chat/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
    });
  }

  res.json({
    success: true,
    session: {
      id: session.id,
      messages: session.messages,
      stats: {
        totalMessages: session.messages.length,
        totalTokens: session.totalTokens,
        duration: Date.now() - session.startTime,
      },
    },
  });
});

/**
 * List all active sessions
 */
router.get('/api/test-chat', (req, res) => {
  const activeSessions = Array.from(sessions.values()).map(session => ({
    id: session.id,
    messageCount: session.messages.length,
    totalTokens: session.totalTokens,
    lastActivity: session.lastActivity,
    duration: Date.now() - session.startTime,
  }));

  res.json({
    success: true,
    sessions: activeSessions,
    count: activeSessions.length,
  });
});

export default router;
