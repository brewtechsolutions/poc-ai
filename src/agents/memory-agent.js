/**
 * MemoryAgent - Handles conversation memory storage and retrieval.
 * Provides persistent context across turns by storing conversation history,
 * memory snapshots, pending questions, and context tags in PostgreSQL.
 *
 * Gracefully handles missing fields (before migration is applied) by checking
 * if the fields exist before querying/updating.
 */

import prisma from '../config/database.js';

export class MemoryAgent {
  constructor(openai) {
    this.openai = openai;
  }

  /**
   * Check if memory fields exist in the Conversation model
   * Returns false if migration hasn't been applied yet
   */
  async hasMemoryFields() {
    try {
      // Try to query with a memory-specific field
      await prisma.conversation.findFirst({
        select: { conversationHistory: true }
      });
      return true;
    } catch (err) {
      if (err.code === 'UndefinedColumn' || err.message?.includes('conversationHistory')) {
        return false;
      }
      // Other errors might indicate a different issue
      console.warn('[MemoryAgent] Error checking memory fields:', err.message);
      return false;
    }
  }

  /**
   * Store a turn in conversation history and update memory snapshot
   * @param {string} conversationId - Prisma Conversation ID
   * @param {object} turn - { role: 'user'|'assistant', content: string, intent?: object, entities?: object }
   */
  async storeTurn(conversationId, turn) {
    try {
      // Check if memory fields exist
      const hasFields = await this.hasMemoryFields();
      if (!hasFields) {
        if (process.env.DEBUG === 'true') {
          console.log('[MemoryAgent] Memory fields not available yet (migration pending)');
        }
        return;
      }

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
    } catch (err) {
      console.warn('[MemoryAgent] storeTurn failed:', err.message);
    }
  }

  /**
   * Retrieve relevant context for AI injection
   * @param {string} conversationId
   * @param {object} currentMessage - Current user message for relevance filtering
   */
  async getContext(conversationId, currentMessage) {
    try {
      // Check if memory fields exist
      const hasFields = await this.hasMemoryFields();
      if (!hasFields) {
        if (process.env.DEBUG === 'true') {
          console.log('[MemoryAgent] Memory fields not available yet (migration pending)');
        }
        return null;
      }

      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: {
          conversationHistory: true,
          memorySnapshot: true,
          conversationPhase: true,
          pendingQuestions: true,
          contextTags: true,
          lastEntitiesRaw: true,
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
        lastShownProducts: conversation.lastShownProducts || []
      };
    } catch (err) {
      console.warn('[MemoryAgent] getContext failed:', err.message);
      return null;
    }
  }

  /**
   * Update memory snapshot with new AI-interpreted context
   */
  async updateMemorySnapshot(conversationId, updates) {
    try {
      const hasFields = await this.hasMemoryFields();
      if (!hasFields) return;

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

      // Build update data - lastEntitiesRaw is a top-level field, memorySnapshot is JSON
      const updateData = { memorySnapshot: updated };
      if (updates.lastEntities !== undefined) {
        updateData.lastEntitiesRaw = updates.lastEntities;
      }

      await prisma.conversation.update({
        where: { id: conversationId },
        data: updateData
      });
    } catch (err) {
      console.warn('[MemoryAgent] updateMemorySnapshot failed:', err.message);
    }
  }

  /**
   * Add a pending question that AI is awaiting answer to
   */
  async addPendingQuestion(conversationId, question) {
    try {
      const hasFields = await this.hasMemoryFields();
      if (!hasFields) return;

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
    } catch (err) {
      console.warn('[MemoryAgent] addPendingQuestion failed:', err.message);
    }
  }

  /**
   * Resolve (remove) a pending question by ID
   */
  async resolvePendingQuestion(conversationId, questionId) {
    try {
      const hasFields = await this.hasMemoryFields();
      if (!hasFields) return;

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
    } catch (err) {
      console.warn('[MemoryAgent] resolvePendingQuestion failed:', err.message);
    }
  }

  /**
   * Update conversation phase based on intent
   */
  async updatePhase(conversationId, newPhase) {
    try {
      const hasFields = await this.hasMemoryFields();
      if (!hasFields) return;

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { conversationPhase: newPhase }
      });
    } catch (err) {
      console.warn('[MemoryAgent] updatePhase failed:', err.message);
    }
  }

  /**
   * Add or remove context tags
   */
  async updateTags(conversationId, tagsToAdd = [], tagsToRemove = []) {
    try {
      const hasFields = await this.hasMemoryFields();
      if (!hasFields) return;

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
    } catch (err) {
      console.warn('[MemoryAgent] updateTags failed:', err.message);
    }
  }
}