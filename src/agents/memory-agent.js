/**
 * MemoryAgent - Handles conversation memory storage and retrieval.
 * Provides persistent context across turns by storing conversation history,
 * memory snapshots, pending questions, and context tags in PostgreSQL.
 */

import prisma from '../config/database.js';

export class MemoryAgent {
  constructor(openai) {
    this.openai = openai;
  }

  /**
   * Store a turn in conversation history and update memory snapshot
   * @param {string} conversationId - Prisma Conversation ID
   * @param {object} turn - { role: 'user'|'assistant', content: string, intent?: object, entities?: object }
   */
  async storeTurn(conversationId, turn) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { conversationHistory: true, memorySnapshot: true }
    });

    if (!conversation) {
      console.warn(`Conversation ${conversationId} not found for storeTurn`);
      return;
    }

    const history = conversation.conversationHistory || [];
    history.push({ ...turn, timestamp: new Date().toISOString() });

    // Keep last 50 turns to avoid token bloat
    const trimmedHistory = history.slice(-50);

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        conversationHistory: trimmedHistory,
        lastAiInterpretation: turn.intent ? JSON.stringify(turn.intent) : undefined
      }
    });
  }

  /**
   * Retrieve relevant context for AI injection
   * @param {string} conversationId
   * @param {object} currentMessage - Current user message for relevance filtering
   */
  async getContext(conversationId, currentMessage) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        conversationHistory: true,
        memorySnapshot: true,
        conversationPhase: true,
        pendingQuestions: true,
        contextTags: true,
        lastEntitiesRaw: true,
        language: true,
        lastShownProducts: true
      }
    });

    if (!conversation) return null;

    return {
      history: conversation.conversationHistory || [],
      memory: conversation.memorySnapshot || {},
      phase: conversation.conversationPhase || 'initial',
      pendingQuestions: conversation.pendingQuestions || [],
      tags: conversation.contextTags || [],
      lastEntities: conversation.lastEntitiesRaw || {},
      language: conversation.language,
      lastShownProducts: conversation.lastShownProducts || []
    };
  }

  /**
   * Update memory snapshot with new AI-interpreted context
   */
  async updateMemorySnapshot(conversationId, updates) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { memorySnapshot: true }
    });

    if (!conversation) {
      console.warn(`Conversation ${conversationId} not found for updateMemorySnapshot`);
      return;
    }

    const current = conversation.memorySnapshot || {};
    const updated = { ...current, ...updates, lastUpdated: new Date().toISOString() };

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { memorySnapshot: updated }
    });
  }

  /**
   * Add a pending question that AI is awaiting answer to
   */
  async addPendingQuestion(conversationId, question) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { pendingQuestions: true }
    });

    if (!conversation) {
      console.warn(`Conversation ${conversationId} not found for addPendingQuestion`);
      return;
    }

    const questions = conversation.pendingQuestions || [];
    questions.push({ id: Date.now().toString(), question, createdAt: new Date().toISOString() });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { pendingQuestions: questions }
    });
  }

  /**
   * Resolve (remove) a pending question by ID
   */
  async resolvePendingQuestion(conversationId, questionId) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { pendingQuestions: true }
    });

    if (!conversation) {
      console.warn(`Conversation ${conversationId} not found for resolvePendingQuestion`);
      return;
    }

    const questions = (conversation.pendingQuestions || []).filter(q => q.id !== questionId);

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { pendingQuestions: questions }
    });
  }

  /**
   * Update conversation phase based on intent
   */
  async updatePhase(conversationId, newPhase) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { conversationPhase: newPhase }
    });
  }

  /**
   * Add or remove context tags
   */
  async updateTags(conversationId, tagsToAdd = [], tagsToRemove = []) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { contextTags: true }
    });

    if (!conversation) {
      console.warn(`Conversation ${conversationId} not found for updateTags`);
      return;
    }

    let tags = conversation.contextTags || [];
    tags = [...new Set([...tags, ...tagsToAdd])]; // Add new
    tags = tags.filter(t => !tagsToRemove.includes(t)); // Remove specified

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { contextTags: tags }
    });
  }
}