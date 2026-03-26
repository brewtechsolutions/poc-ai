import fs from 'fs';
import path from 'path';
import prisma from '../config/database.js';
import openai, { TOKEN_CONFIG } from '../config/openai.js';
import ProductRecommender from '../utils/product-recommender.js';
import ImageProcessor from '../utils/image-processor.js';
import VoiceProcessor from '../utils/voice-processor.js';
import SearchAgent from '../agents/search-agent.js';
import LanguageAgent from '../agents/language-agent.js';
import AnalysisAgent from '../agents/analysis-agent.js';
import ResponseAgent from '../agents/response-agent.js';
import { AI_ROLES, getRoleConfig } from '../config/ai-registry.js';
import { resolveProductFromLedger } from '../utils/session-option-sets.js';

// Load workflow JSON without import assertions for broader Node compatibility
const workflowPath = path.resolve(process.cwd(), 'workflow.json');
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));

/**
 * Workflow Engine - Executes the workflow JSON
 */
class WorkflowEngine {
  constructor() {
    this.workflow = workflow.workflow;
    this.optimizerRoleConfig = getRoleConfig(AI_ROLES.OPTIMIZER);
    this.nodes = new Map();
    this.workflow.nodes.forEach(node => {
      this.nodes.set(node.id, node);
    });
  }

  /**
   * Execute workflow from start node
   */
  async execute(context) {
    let currentNode = this.nodes.get('start');
    const executionContext = {
      ...context,
      tokensUsed: 0,
      startTime: Date.now(),
      conversationHistory: context.conversationHistory || [],
      workflowSteps: [],
      errors: [],
      allResults: [],
      finalResponse: null,
      visitedNodes: new Set(),
      maxIterations: 100,
      iterationCount: 0,
      lastIntent: context.lastIntent,
      languageLocked: context.languageLocked,
    };

    const DEBUG = process.env.DEBUG === 'true';

    while (currentNode && currentNode.type !== 'end') {
      // Safety check: prevent infinite loops
      executionContext.iterationCount++;
      if (executionContext.iterationCount > executionContext.maxIterations) {
        console.error(`❌ Workflow exceeded max iterations (${executionContext.maxIterations}). Breaking loop.`);
        executionContext.errors.push(`Workflow loop detected after ${executionContext.iterationCount} iterations`);
        break;
      }

      // Check for repeated node visits (potential loop)
      const visitCount = executionContext.workflowSteps.filter(s => s.node === currentNode.id).length;
      if (visitCount > 3) {
        console.error(`❌ Node ${currentNode.id} visited ${visitCount} times. Possible infinite loop. Breaking.`);
        executionContext.errors.push(`Infinite loop detected at node ${currentNode.id}`);
        // Force to response_sender to break loop
        currentNode = this.nodes.get('response_sender');
        if (!currentNode) {
          currentNode = this.nodes.get('end');
        }
        break;
      }
      try {
        if (DEBUG) {
          console.log(`\n[Workflow] → ${currentNode.name} (${currentNode.id})`);
        }

        const result = await this.executeNode(currentNode, executionContext);
        
        // Track workflow step
        executionContext.workflowSteps.push({
          node: currentNode.id,
          nodeName: currentNode.name,
          result: {
            hasData: !!result.data,
            hasError: !!result.error,
            confidence: result.confidence,
            found: result.found,
            tokensUsed: result.tokensUsed,
          },
        });

        if (result.error) {
          const errorMsg = `Error in node ${currentNode.id} (${currentNode.name}): ${result.error}`;
          console.error(`❌ ${errorMsg}`);
          executionContext.errors.push(errorMsg);
          
          // Try to continue to escalation, but only if we haven't been there already
          if (!executionContext.visitedNodes.has('agent_escalation')) {
            currentNode = this.nodes.get('agent_escalation');
          } else {
            // Already escalated, go to response sender with error message
            console.error('⚠️ Already escalated, going to response sender');
            currentNode = this.nodes.get('response_sender');
          }
          continue;
        }

        executionContext.tokensUsed += result.tokensUsed || 0;
        executionContext.lastResult = result;
        executionContext.allResults.push(result); // Store for response extraction

        // Track language, but never overwrite a locked language.
        if (result.data?.language) {
          if (!executionContext.language) {
            executionContext.language = result.data.language;
          } else if (!executionContext.languageLocked) {
            executionContext.language = result.data.language;
          }
        }
        if (result.data?.intent) {
          executionContext.lastIntent = result.data.intent;
        }

        // Track final response if found
        if (result.data?.finalResponse || result.data?.optimized || result.data?.response) {
          executionContext.finalResponse = result.data.finalResponse || 
                                          result.data.optimized || 
                                          result.data.response;
        }

        if (DEBUG) {
          console.log(`   ✓ Completed. Tokens: ${result.tokensUsed || 0}, Confidence: ${result.confidence || 'N/A'}`);
          if (result.data?.intent) console.log(`   Intent: ${result.data.intent}`);
          if (result.data?.products) console.log(`   Products found: ${result.data.products.length}`);
          if (result.next) console.log(`   Result.next: ${result.next}`);
        }

        // Determine next node
        const nextNode = this.getNextNode(currentNode, result, executionContext);
        
        if (DEBUG) {
          if (nextNode) {
            console.log(`   → Next: ${nextNode.name} (${nextNode.id})`);
          } else {
            console.log(`   ⚠️ No next node found, going to end`);
          }
        }
        
        currentNode = nextNode;
      } catch (error) {
        const errorMsg = `Fatal error in ${currentNode.id}: ${error.message}`;
        console.error(`💥 ${errorMsg}`);
        console.error(error.stack);
        executionContext.errors.push(errorMsg);
        
        // Only escalate if we haven't already
        if (!executionContext.visitedNodes.has('agent_escalation')) {
          currentNode = this.nodes.get('agent_escalation');
        } else {
          // Already escalated, go to response sender
          console.error('⚠️ Already escalated, going to response sender');
          currentNode = this.nodes.get('response_sender');
        }
      }
    }

    executionContext.responseTime = Date.now() - executionContext.startTime;

    // Surface AnalysisAgent outputs for route/session persistence
    executionContext.hasAskedBudget = executionContext.hasAskedBudget || false;
    executionContext.hasAskedArea = executionContext.hasAskedArea || false;
    executionContext.hasAskedModel = executionContext.hasAskedModel || false;
    executionContext.skipAlreadyShownIds = executionContext.skipAlreadyShownIds || [];
    executionContext.salesInsight = executionContext.salesInsight || null;
    executionContext.missingInfo = executionContext.missingInfo || [];
    executionContext.analysisEntities = executionContext.entities || {};
    executionContext.analysisSource = executionContext.lastResult?.data?.source || null;
    
    if (DEBUG) {
      console.log(`\n[Workflow] ✓ Completed in ${executionContext.responseTime}ms`);
      console.log(`   Total tokens: ${executionContext.tokensUsed}`);
      console.log(`   Steps: ${executionContext.workflowSteps.length}`);
      if (executionContext.errors.length > 0) {
        console.log(`   Errors: ${executionContext.errors.length}`);
      }
    }

    return executionContext;
  }

  /**
   * Execute a single workflow node
   */
  async executeNode(node, context) {
    console.log(`[Workflow] Executing node: ${node.name} (${node.id})`);

    switch (node.type) {
      case 'trigger':
        return this.handleTrigger(node, context);
      
      case 'classifier':
        return this.handleClassifier(node, context);

      case 'analysis_agent':
        return await this.handleAnalysisAgent(node, context);

      case 'analysis_router':
        return this.handleAnalysisRouter(node, context);
      
      case 'nlp':
        // Used by legacy voice/image fallback paths.
        // Text messages now go through analysis_agent instead.
        return await LanguageAgent.handleNLP(node, context, { nodes: this.nodes });
      
      case 'router':
        return LanguageAgent.handleRouter(node, context);
      
      case 'database':
        return await this.handleDatabase(node, context);
      
      case 'ml':
        return await this.handleML(node, context);
      
      case 'formatter':
        return ResponseAgent.handleFormatter(node, context, this.workflow);
      
      case 'optimizer':
        return await ResponseAgent.handleOptimizer(node, context);
      
      case 'handler':
        return ResponseAgent.handleHandler(node, context, this.workflow);
      
      case 'escalation':
        return await this.handleEscalation(node, context);
      
      case 'action':
        return ResponseAgent.handleAction(node, context, this.workflow);
      
      case 'vision':
        return await this.handleVision(node, context);
      
      case 'speech':
        return await this.handleSpeech(node, context);
      
      case 'language_selector':
        return LanguageAgent.handleLanguageSelector(node, context);
      
      case 'model_details':
        return await this.handleModelDetails(node, context);

      case 'selection_clarify':
        return this.handleSelectionClarify(node, context);
      
      default:
        return { data: context.lastResult?.data, tokensUsed: 0 };
    }
  }

  /**
   * Return a fixed clarification line when numbered pick could not be mapped to any list.
   */
  handleSelectionClarify(node, context) {
    const entities = context.lastResult?.data?.entities || context.entities || {};
    const msg =
      entities.message ||
      entities.clarification_message ||
      'Could you clarify which option you mean?';
    return {
      data: {
        finalResponse: msg,
        formatted: msg,
        response: msg,
        optimized: msg,
        intent: 'clarify_selection',
      },
      tokensUsed: 0,
      next: node.config?.next || 'response_optimizer',
    };
  }

  /**
   * Resolve user selection (number or name) to a product from option ledger, lastShownProducts, or DB lookup; return full details or "we don't have this model".
   */
  async handleModelDetails(node, context) {
    const templateKey = node.config.template || 'model_detail_full';
    const language = context.language || context.lastResult?.data?.language || 'english';
    const lastShown = context.lastShownProducts || context.metadata?.lastShownProducts;
    const message = (context.user_message || '').trim().toLowerCase();
    const entities = context.lastResult?.data?.entities || context.entities || {};

    // selected_index can come from router (pass-through) or from NLP result in allResults
    let selectedIndex = entities.selected_index;
    if (!Number.isInteger(selectedIndex) && context.allResults?.length) {
      const nlpResult = context.allResults.find(
        r =>
          r.data?.intent === 'model_selection' &&
          (r.data?.entities?.selected_index != null || r.data?.entities?.selected_id != null),
      );
      selectedIndex = nlpResult?.data?.entities?.selected_index;
    }

    let product = resolveProductFromLedger(context, entities);
    if (!product && lastShown && Array.isArray(lastShown) && lastShown.length > 0) {
      const idx = selectedIndex;
      if (Number.isInteger(idx) && idx >= 1 && idx <= lastShown.length) {
        product = lastShown[idx - 1];
      }
      if (!product) {
        product = lastShown.find(p =>
          (p.name && String(p.name).toLowerCase().includes(message)) ||
          (p.brand && String(p.brand).toLowerCase().includes(message)) ||
          (p.features?.model && String(p.features.model).toLowerCase().includes(message))
        ) || null;
      }
    }

    // Not in list: try DB lookup by model name (e.g. "i want ego s" -> search for "ego s")
    if (!product) {
      const modelName =
        (entities.model || '').toString().trim() ||
        LanguageAgent.extractModelNameFromMessage(context.user_message || '');
      if (modelName.length >= 2) {
        const dbMatches = await prisma.product.findMany({
          where: {
            AND: [
              { active: true },
              { inStock: true },
              {
                OR: [
                  { name: { contains: modelName, mode: 'insensitive' } },
                  { brand: { contains: modelName, mode: 'insensitive' } },
                  { description: { contains: modelName, mode: 'insensitive' } },
                ],
              },
            ],
          },
          take: 5,
          orderBy: { popularity: 'desc' },
        });
        if (dbMatches.length > 0) {
          product = dbMatches[0];
        } else {
          // Fallback: match on features.model (JSON field)
          const allActive = await prisma.product.findMany({
            where: { AND: [ { active: true }, { inStock: true } ] },
            take: 200,
          });
          const byFeaturesModel = allActive.find(p =>
            p.features && typeof p.features === 'object' &&
            String((p.features.model || '')).toLowerCase().includes(modelName.toLowerCase())
          );
          if (byFeaturesModel) product = byFeaturesModel;
        }
      }
    }

    if (!product) {
      const notFoundTpl = this.workflow.templates?.model_not_found;
      const msg = notFoundTpl?.[language] || notFoundTpl?.english || "I'm sorry, we don't have this model. Would you like to see other bikes we have?";
      return {
        data: {
          response: msg,
          formatted: msg,
          finalResponse: msg,
        },
        tokensUsed: 0,
      };
    }

    const features = product.features || {};
    const specs = features.specifications
      ? Object.entries(features.specifications).map(([k, v]) => `${k}: ${v}`).join('\n')
      : (features.engine ? `Engine: ${features.engine}` : '') + (features.fuelSystem ? `\nFuel: ${features.fuelSystem}` : '') + (features.transmission ? `\nTransmission: ${features.transmission}` : '');
    const nameOnly = (product.name || '').trim();
    const modelPart = (features.model || '').trim();
    const title = modelPart && !nameOnly.toLowerCase().includes(modelPart.toLowerCase()) ? `${nameOnly} ${modelPart}` : nameOnly;
    const locations = features.locations && features.locations.length ? ` (${features.locations.join(', ')})` : '';
    const engine = features.engineSize ? `${features.engineSize}cc` : (features.engine || '');
    const type = features.type || product.subcategory || '';
    const inStockText = product.inStock ? 'In Stock' : 'Out of Stock';

    let template = '';
    if (typeof this.workflow.templates?.[templateKey] === 'object') {
      template = this.workflow.templates[templateKey][language] || this.workflow.templates[templateKey]['english'] || '';
    } else {
      template = this.workflow.templates?.[templateKey] || '';
    }

    let response = template
      .replace(/\{name\}/g, title)
      .replace(/\{description\}/g, product.description || 'No description')
      .replace(/\{currency\}/g, product.currency || 'MYR')
      .replace(/\{price\}/g, (product.price != null && product.price.toLocaleString) ? product.price.toLocaleString() : product.price)
      .replace(/\{locations\}/g, locations)
      .replace(/\{engine\}/g, engine)
      .replace(/\{type\}/g, type)
      .replace(/\{inStock\}/g, inStockText)
      .replace(/\{specs\}/g, specs || '—');

    return {
      data: {
        product,
        response,
        formatted: response,
        finalResponse: response,
      },
      tokensUsed: 0,
    };
  }

  // extractModelNameFromMessage and language selection / NLP / routing logic
  // have been moved into LanguageAgent to keep this class focused on orchestration.

  /**
   * Get next node based on current result
   */
  getNextNode(currentNode, result, context) {
    const config = currentNode.config || {};
    const DEBUG = process.env.DEBUG === 'true';
    
    // PRIORITY 1: Check if result has explicit next node (from handler - highest priority)
    if (result.next) {
      const nextNode = this.nodes.get(result.next);
      if (DEBUG) console.log(`   [NextNode] Using explicit next from result: ${result.next}`);
      if (nextNode) return nextNode;
      // If node not found, log warning but continue to other checks
      if (DEBUG) console.log(`   [NextNode] ⚠️ Node "${result.next}" not found in workflow, trying other routes`);
    }
    
    // PRIORITY 2: Check config.next (direct routing from workflow JSON)
    if (config.next) {
      const nextNode = this.nodes.get(config.next);
      if (DEBUG) console.log(`   [NextNode] Using config.next: ${config.next}`);
      if (nextNode) return nextNode;
    }

    // PRIORITY 3: Check confidence-based routing
    if (config.next_high_confidence && result.confidence >= 0.7) {
      const nextNode = this.nodes.get(config.next_high_confidence);
      if (DEBUG) console.log(`   [NextNode] High confidence (${result.confidence}), using: ${config.next_high_confidence}`);
      if (nextNode) return nextNode;
    }

    if (config.next_low_confidence && result.confidence < 0.7) {
      const nextNode = this.nodes.get(config.next_low_confidence);
      if (DEBUG) console.log(`   [NextNode] Low confidence (${result.confidence}), using: ${config.next_low_confidence}`);
      if (nextNode) return nextNode;
    }

    // PRIORITY 4: Check found/not found routing
    if (config.next_found && result.found) {
      const nextNode = this.nodes.get(config.next_found);
      if (DEBUG) console.log(`   [NextNode] Found=true, using: ${config.next_found}`);
      if (nextNode) return nextNode;
    }

    if (config.next_not_found && !result.found) {
      const nextNode = this.nodes.get(config.next_not_found);
      if (DEBUG) console.log(`   [NextNode] Found=false, using: ${config.next_not_found}`);
      if (nextNode) return nextNode;
    }

    // PRIORITY 5: Context complete / missing (e.g. context_collector)
    if (config.next_complete && result.data?.contextComplete) {
      const nextNode = this.nodes.get(config.next_complete);
      if (DEBUG) console.log(`   [NextNode] Context complete, using: ${config.next_complete}`);
      if (nextNode) return nextNode;
    }
    if (config.next_missing_info && !result.data?.contextComplete) {
      const nextNode = this.nodes.get(config.next_missing_info);
      if (DEBUG) console.log(`   [NextNode] Missing info, using: ${config.next_missing_info}`);
      if (nextNode) return nextNode;
    }

    // PRIORITY 6: Check fallback
    if (config.fallback) {
      const nextNode = this.nodes.get(config.fallback);
      if (DEBUG) console.log(`   [NextNode] Using fallback: ${config.fallback}`);
      if (nextNode) return nextNode;
    }

    // Default to end
    if (DEBUG) console.log(`   [NextNode] No routing found, going to end`);
    return this.nodes.get('end');
  }

  // Node handlers
  handleTrigger(node, context) {
    if (process.env.DEBUG === 'true') {
      console.log(`   [Trigger] Message: "${context.user_message?.substring(0, 50)}..."`);
    }
    
    return {
      data: {
        message: context.user_message,
        metadata: context.metadata || {},
      },
      tokensUsed: 0,
    };
  }

  handleClassifier(node, context) {
    const messageType = context.metadata?.message_type || 'text';
    const route = node.config.classify.find(r => r.type === messageType);
    
    // Update context for next node
    context.messageType = messageType;
    
    if (process.env.DEBUG === 'true') {
      console.log(`   [Classifier] Message type: ${messageType}, Next: ${route?.next || 'N/A'}`);
    }
    
    return {
      data: { messageType, route },
      tokensUsed: 0,
      next: route?.next,
    };
  }

  /**
   * AnalysisAgent: run intent/entity analysis and write to context for analysis_router.
   * Uses the dedicated AnalysisAgent (separate from search engine / LanguageAgent).
   */
  async handleAnalysisAgent(node, context) {
    const plan = await AnalysisAgent.analyze(context, {
      activeSkills: node.config?.active_skills || AnalysisAgent.listSkills(),
      model: node.config?.model,
      temperature: node.config?.temperature,
      max_tokens: node.config?.max_tokens,
      config: node.config, // Pass full config for intents/entities/system_prompt
    });
    const tokensUsed = plan.tokensUsed ?? 0;
    context.entities = { ...(context.entities || {}), ...(plan.entities || {}) };
    if (plan.hasAskedBudget !== undefined) context.hasAskedBudget = plan.hasAskedBudget;
    if (plan.hasAskedArea !== undefined) context.hasAskedArea = plan.hasAskedArea;
    if (plan.hasAskedModel !== undefined) context.hasAskedModel = plan.hasAskedModel;
    if (plan.skipAlreadyShownIds?.length > 0) context.skipAlreadyShownIds = plan.skipAlreadyShownIds;
    if (plan.salesInsight != null) context.salesInsight = plan.salesInsight;
    if (plan.suggestedQuestion != null) context.suggestedQuestion = plan.suggestedQuestion;
    if (plan.missingInfo?.length > 0) context.missingInfo = plan.missingInfo;
    return {
      data: {
        intent: plan.intent,
        // merged entities for downstream nodes
        entities: context.entities,
        // turn-local entities from this AnalysisAgent call
        entitiesForTurn: plan.entities || {},
        language: plan.language,
        confidence: plan.confidence,
        source: plan.source,
        suggestedQuestion: plan.suggestedQuestion,
        missingInfo: plan.missingInfo || [],
        hasAskedBudget: plan.hasAskedBudget,
        hasAskedArea: plan.hasAskedArea,
        hasAskedModel: plan.hasAskedModel,
        salesInsight: plan.salesInsight,
      },
      tokensUsed,
      next: node.config?.next || 'analysis_router',
    };
  }

  /**
   * AnalysisRouter: slot-based routing that works for any product domain.
   * Priority: Intent-based routing (from workflow.json) → Slot-based routing (only for recommendation intents) → Default routing
   * Generic and profile-agnostic - reads search node ID from workflow config.
   */
  handleAnalysisRouter(node, context) {
    const result = LanguageAgent.handleRouter(node, context);
    const intent = result.data?.intent;

    // Get search node ID from config (defaults to 'bike_search' for backward compatibility)
    const searchNodeId = node.config?.search_node_id || 'bike_search';
    const recommendationIntents = node.config?.recommendation_intents || ['product_recommendation', 'bike_recommendation'];
    const areaQuestionIntents = node.config?.area_question_intents || ['area_question'];
    
    // Prefer entities from this turn (from AnalysisAgent) over merged history
    const turnEntities =
      context.lastResult?.data?.entitiesForTurn ||
      result.data?.entities ||
      {};

    // Generic slot detection (works for any domain)
    const hasBudget = !!(turnEntities.budget || turnEntities.price || turnEntities.price_range);
    const hasBrand = !!(turnEntities.brand && String(turnEntities.brand).trim());
    const hasModel = !!(turnEntities.model && String(turnEntities.model).trim());
    const hasArea = !!(turnEntities.area || turnEntities.location);
    const hasProductType = !!(turnEntities.product_type || turnEntities.category);

    // Check intent type
    const isRecommendationIntent = recommendationIntents.includes(intent);
    const isAreaQuestionIntent = areaQuestionIntents.includes(intent);

    // PRIORITY 1: Respect intent-based routing from workflow.json first
    // If LanguageAgent.handleRouter already found a route (result.next exists), use it
    // UNLESS it's a recommendation intent that needs slot-based enhancement
    if (result.next && !isRecommendationIntent) {
      // For non-recommendation intents (like area_question, budget_question, etc.),
      // respect the workflow.json route (e.g. area_question → area_handler)
      if (process.env.DEBUG === 'true') {
        console.log(`   [AnalysisRouter] Using intent-based route: ${intent} → ${result.next}`);
      }
      return result;
    }

    // PRIORITY 2: Slot-based routing ONLY for recommendation/search intents
    // This enhances recommendation intents based on what slots are filled
    
    // 0) Area-only with recommendation intent: user gave area/location → search with area context
    // BUT: Only if intent is actually a recommendation/search intent, not area_question
    if (isRecommendationIntent && hasArea && !hasBudget && !hasModel && !hasBrand) {
      // Merge area entity into context for search
      context.entities = { ...(context.entities || {}), ...turnEntities };
      if (process.env.DEBUG === 'true') {
        console.log(`   [AnalysisRouter] Area-only recommendation → ${searchNodeId} with area context`, turnEntities);
      }
      return {
        ...result,
        data: {
          ...result.data,
          entities: context.entities,
        },
        next: searchNodeId,
      };
    }

    // 1) Budget-only: user gave budget but NO model/brand in this turn → search with budget filter
    if (isRecommendationIntent && hasBudget && !hasBrand && !hasModel) {
      context.searchType = 'budget_only';
      if (process.env.DEBUG === 'true') {
        console.log(`   [AnalysisRouter] Budget-only ${intent} → ${searchNodeId} (budget_only)`, turnEntities);
      }
      return {
        ...result,
        data: {
          ...result.data,
          searchType: 'budget_only',
        },
        next: searchNodeId,
      };
    }

    // 2) Model/brand/product_type present in this turn → search with model/brand filter
    const hasModelOrBrandOrType = hasBrand || hasModel || hasProductType;
    if (isRecommendationIntent && hasModelOrBrandOrType) {
      if (process.env.DEBUG === 'true') {
        console.log(`   [AnalysisRouter] User gave model/brand/type this turn → ${searchNodeId} first`, turnEntities);
      }
      return { ...result, next: searchNodeId };
    }

    // PRIORITY 3: Fall back to default routing from workflow.json
    // This handles cases where LanguageAgent.handleRouter found a route but we didn't override it
    return result;
  }


  async handleDatabase(node, context) {
    const operation = node.config.operation;
    const lastResult = context.lastResult?.data;

    try {
      switch (operation) {
        case 'semantic_search':
          return await SearchAgent.semanticProductSearch(node, context, lastResult);
        
        case 'get_price':
          return await this.getProductPrice(node, context, lastResult);
        
        case 'get_order_status':
          return await this.getOrderStatus(node, context, lastResult);
        
        case 'log':
          return await this.logConversation(node, context);
        
        case 'visual_search':
          return await this.visualProductSearch(node, context, lastResult);
        
        default:
          return { data: {}, tokensUsed: 0, found: false };
      }
    } catch (error) {
      console.error('Database operation error:', error);
      return { data: {}, tokensUsed: 0, found: false, error: error.message };
    }
  }

  async getProductPrice(node, context, lastResult) {
    const productName = lastResult?.entities?.product_name || context.user_message;
    
    const product = await prisma.product.findFirst({
      where: {
        name: { contains: productName, mode: 'insensitive' },
        active: true,
      },
    });

    return {
      data: { product, price: product?.price },
      tokensUsed: 0,
      found: !!product,
    };
  }

  async getOrderStatus(node, context, lastResult) {
    // Implementation for order status check
    return {
      data: { status: 'pending' },
      tokensUsed: 0,
      found: false,
    };
  }

  async visualProductSearch(node, context, lastResult) {
    // Get image analysis from previous vision node
    const analysis = context.lastResult?.data?.analysis || lastResult?.analysis;
    
    if (!analysis || !analysis.success) {
      return {
        data: { products: [] },
        tokensUsed: 0,
        found: false,
      };
    }

    // Use analysis to search products
    const searchTerms = [
      analysis.product_name,
      analysis.category,
      analysis.brand,
    ].filter(Boolean).join(' ');

    if (!searchTerms) {
      return {
        data: { products: [] },
        tokensUsed: 0,
        found: false,
      };
    }

    const products = await ProductRecommender.searchProducts(searchTerms, node.config.limit || 10);

    return {
      data: { products, analysis },
      tokensUsed: 0,
      found: products.length > 0,
    };
  }

  async logConversation(node, context) {
    // Save conversation to database
    // Preserve the response from previous nodes
    const previousResponse = context.lastResult?.data?.finalResponse ||
                            context.lastResult?.data?.optimized ||
                            context.lastResult?.data?.response ||
                            context.lastResult?.data?.formatted;
    
    return {
      data: { 
        logged: true,
        // Preserve response so it's available after logging
        finalResponse: previousResponse,
        response: previousResponse,
        optimized: previousResponse,
      },
      tokensUsed: 0,
    };
  }

  async handleML(node, context) {
    const lastResult = context.lastResult?.data;
    const products = lastResult?.products || [];
    const userQuery = context.user_message;

    // Delegate search-related ML nodes to SearchAgent
    if (
      node.id === 'context_collector' ||
      node.id === 'product_recommender' ||
      node.id === 'bike_ranker' ||
      node.id === 'product_ranker' ||
      node.id === 'no_results_handler'
    ) {
      return await SearchAgent.handleML(node, context, this.workflow);
    }

    // Generic ML: nodes with system_prompt that return JSON (clarification_handler, smart_question_generator, no_results_handler)
    if (node.config.system_prompt && node.config.next) {
      // Brand unavailable: user asked for a brand we don't stock — use template, no LLM
      if (node.id === 'no_results_handler' && context.lastResult?.data?.brandUnavailable) {
        const d = context.lastResult.data;
        const brand = d.brandRequested || 'that brand';
        const availableBrands = Array.isArray(d.availableBrands) ? d.availableBrands.join(', ') : '';
        const lang = context.language || 'english';
        const templates = this.workflow.templates?.brand_not_available;
        const noResultsTemplates = this.workflow.templates?.no_results;
        let message = templates?.[lang] || templates?.english || noResultsTemplates?.[lang] || noResultsTemplates?.english || '';
        message = message.replace(/\{brand\}/g, brand).replace(/\{available_brands\}/g, availableBrands);
        if (process.env.DEBUG === 'true') console.log('[Workflow] Brand unavailable response:', brand, availableBrands);
        return {
          data: { message, intent: 'no_results' },
          tokensUsed: 0,
          confidence: 0.95,
        };
      }
      // If AnalysisAgent already generated a question, use it directly — no LLM call needed
      if (node.id === 'smart_question_generator') {
        const prebuiltQuestion = context.suggestedQuestion || context.lastResult?.data?.suggestedQuestion;
        if (prebuiltQuestion) {
          if (process.env.DEBUG === 'true') {
            console.log(`[SmartQuestion] Using pre-built question from AnalysisAgent: "${prebuiltQuestion}"`);
          }
          return {
            data: {
              question: prebuiltQuestion,
              question_type: context.lastResult?.data?.missingInfo?.[0] || 'other',
              language: context.language || 'english',
              formatted: prebuiltQuestion,
              response: prebuiltQuestion,
            },
            tokensUsed: 0,
            next: node.config?.next || 'question_formatter',
          };
        }
      }
      try {
        const lockedLanguage = context.language || context.metadata?.language || 'english';
        const systemPrompt = [
          `MANDATORY LANGUAGE POLICY: Output ONLY in ${lockedLanguage}.`,
          'Never switch language based on user input language.',
          'If user writes in another language, still reply in the locked conversation language.',
          node.config.system_prompt,
        ].join('\n\n');
        let userContent = typeof userQuery === 'string' ? userQuery : String(context.user_message || '');
        if (node.id === 'no_results_handler' && lastResult) {
          const searchInfo = lastResult.entities || context.metadata?.entities || {};
          userContent = `User's search had no results. They asked for: budget=${searchInfo.budget || 'any'}, area=${searchInfo.area || 'any'}, model=${searchInfo.model || 'any'}. User message: "${userContent}"`;
        }
        if (node.id === 'clarification_handler' && context.lastIntent) {
          userContent = `Last intent: ${context.lastIntent}. User message: "${userContent}". What is missing: budget, area, or model? Ask for ONE thing in a friendly way.`;
        }
        const roleCfg = this.optimizerRoleConfig;
        const completion = await openai.chat.completions.create({
          model: node.config.model || roleCfg.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: node.config.temperature ?? roleCfg.temperature,
          max_tokens: node.config.max_tokens || roleCfg.maxTokens,
          response_format: { type: 'json_object' },
        });
        const content = JSON.parse(completion.choices[0].message.content);
        const tokensUsed = completion.usage?.total_tokens || 0;
        return {
          data: { ...content },
          tokensUsed,
          confidence: content.confidence ?? 0.8,
        };
      } catch (err) {
        console.error('ML node error (', node.id, '):', err.message);
        const lang = context.language || 'english';
        const noResultsTemplates = this.workflow.templates?.no_results;
        const clarificationTemplates = this.workflow.templates?.clarification_questions;
        const fallback = node.id === 'no_results_handler'
          ? { message: noResultsTemplates?.[lang] || noResultsTemplates?.english || '' }
          : { clarification_message: clarificationTemplates?.[lang] || clarificationTemplates?.english || '' };
        return {
          data: fallback,
          tokensUsed: 0,
          confidence: 0.3,
        };
      }
    }

    // Default: no products found
    return {
      data: { products: [], reasoning: 'No results' },
      tokensUsed: 0,
      confidence: 0,
    };
  }

  async handleEscalation(node, context) {
    if (process.env.DEBUG === 'true') {
      console.log('[Workflow] Escalating to human agent');
    }
    
    const language = context.language || context.lastResult?.data?.language || 'english';
    let response = '';
    
    if (typeof this.workflow.templates.agent_transfer === 'object') {
      response = this.workflow.templates.agent_transfer[language] || 
                 this.workflow.templates.agent_transfer['english'] || 
                 'I\'m connecting you with a human agent...';
    } else {
      response = this.workflow.templates.agent_transfer || 'I\'m connecting you with a human agent...';
    }
    
    // Route to response_sender (agent_assigned doesn't exist in workflow)
    const nextNodeId = node.config.next || 'response_sender';
    
    return {
      data: {
        escalated: true,
        response: response,
        formatted: response,
        finalResponse: response,
      },
      tokensUsed: 0,
      // Explicitly set next to prevent infinite loops
      next: nextNodeId,
    };
  }

  async handleVision(node, context) {
    const imageUrl = context.metadata?.media_url || context.metadata?.image_url;
    
    if (!imageUrl) {
      return {
        data: { error: 'No image URL provided' },
        tokensUsed: 0,
        error: 'Missing image URL',
      };
    }

    try {
      const analysis = await ImageProcessor.processImage(imageUrl);
      
      if (!analysis.success) {
        return {
          data: { error: analysis.error },
          tokensUsed: analysis.tokensUsed || 0,
          error: analysis.error,
        };
      }

      return {
        data: {
          analysis,
          product_name: analysis.product_name,
          category: analysis.category,
          brand: analysis.brand,
        },
        tokensUsed: analysis.tokensUsed || 0,
      };
    } catch (error) {
      console.error('Vision processing error:', error);
      return {
        data: { error: error.message },
        tokensUsed: 0,
        error: error.message,
      };
    }
  }

  async handleSpeech(node, context) {
    const audioUrl = context.metadata?.voice_url || context.metadata?.audio_url;
    
    if (!audioUrl) {
      return {
        data: { error: 'No audio URL provided' },
        tokensUsed: 0,
        error: 'Missing audio URL',
      };
    }

    try {
      const transcription = await VoiceProcessor.transcribe(
        audioUrl,
        node.config.language || null
      );

      if (!transcription.success) {
        return {
          data: { error: transcription.error },
          tokensUsed: 0,
          error: transcription.error,
        };
      }

      // Update context with transcribed text for NLP processing
      context.user_message = transcription.text;
      context.transcribed = true;

      return {
        data: {
          text: transcription.text,
          language: transcription.language,
        },
        tokensUsed: 0, // Whisper tokens are separate
      };
    } catch (error) {
      console.error('Speech processing error:', error);
      return {
        data: { error: error.message },
        tokensUsed: 0,
        error: error.message,
      };
    }
  }
}

export default WorkflowEngine;
