import fs from 'fs';
import path from 'path';
import prisma from '../config/database.js';
import openai, { TOKEN_CONFIG } from '../config/openai.js';
import ProductRecommender from '../utils/product-recommender.js';
import ImageProcessor from '../utils/image-processor.js';
import VoiceProcessor from '../utils/voice-processor.js';
import SearchAgent from '../agents/search-agent.js';
import LanguageAgent from '../agents/language-agent.js';
import ResponseAgent from '../agents/response-agent.js';

// Load workflow JSON without import assertions for broader Node compatibility
const workflowPath = path.resolve(process.cwd(), 'workflow.json');
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf-8'));

/**
 * Workflow Engine - Executes the workflow JSON
 */
class WorkflowEngine {
  constructor() {
    this.workflow = workflow.workflow;
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

        // Track detected language in execution context (if not already set)
        if (result.data?.language && !executionContext.language) {
          executionContext.language = result.data.language;
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
      
      case 'nlp':
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
      
      default:
        return { data: context.lastResult?.data, tokensUsed: 0 };
    }
  }

  /**
   * Resolve user selection (number or name) to a product from lastShownProducts or by DB lookup; return full details or "we don't have this model".
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
      const nlpResult = context.allResults.find(r => r.data?.intent === 'model_selection' && r.data?.entities?.selected_index != null);
      selectedIndex = nlpResult?.data?.entities?.selected_index;
    }

    let product = null;
    if (lastShown && Array.isArray(lastShown) && lastShown.length > 0) {
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

    // Context collector: legacy path (kept for compatibility). The real logic lives in SearchAgent.handleML.
    if (node.id === 'context_collector') {
      const entities = this.getEntitiesFromContext(context);
      const hasBudget = !!(entities.budget || entities.price_range);
      const hasArea = !!(entities.area || entities.location);
      const contextComplete = hasBudget || (hasBudget && hasArea);
      const recommendationMode = hasBudget && !hasArea ? 'budget_only' : 'full';

      if (process.env.DEBUG === 'true') {
        console.log(
          `   [ML/context_collector] contextComplete=${contextComplete}, hasBudget=${hasBudget}, hasArea=${hasArea}, mode=${recommendationMode}`,
        );
      }

      return {
        data: {
          ...lastResult,
          entities,
          contextComplete,
          recommendationMode,
        },
        tokensUsed: 0,
        confidence: contextComplete ? 0.95 : 0.5,
      };
    }
    
    // Use ProductRecommender for smart recommendations
    if (node.id === 'product_recommender') {
      const recommendation = await ProductRecommender.recommend(userQuery, {
        preferences: context.userPreferences,
      });
      
      return {
        data: {
          products: recommendation.products,
          reasoning: recommendation.reasoning,
          fallbackProducts: recommendation.fallbackProducts,
        },
        tokensUsed: recommendation.tokensUsed || 0,
        confidence: recommendation.confidence,
      };
    }
    
    // Product Ranker (bike_ranker or product_ranker) - use AI ranking
    if (node.id === 'bike_ranker' || node.id === 'product_ranker') {
      if (products.length === 0) {
        // Route to no_results_handler so user gets "sorry we don't sell this bike"
        return {
          data: { products: [], reasoning: 'No products found' },
          tokensUsed: 0,
          confidence: 0,
          next: 'no_results_handler',
        };
      }

      const entities = this.getEntitiesFromContext(context);
      const requestedModel = (entities.model || entities.brand || '').toString().trim();
      const isMoreOptions = context.lastIntent === 'more_options';

      // When user said "got others?" / more options: show more bikes without "model first + alternative" framing (no intro reasoning)
      if (isMoreOptions) {
        const topN = node.config.top_n || 5;
        const moreProducts = products.slice(0, topN);
        if (process.env.DEBUG === 'true') console.log(`   [bike_ranker] more_options: returning ${moreProducts.length} additional options (no model-first framing)`);
        return {
          data: {
            products: moreProducts,
            recommendation_reasoning: '',
            alternative_reasoning: '',
            reasoning: 'More options within your criteria.',
          },
          tokensUsed: 0,
          confidence: 0.9,
        };
      }

      // When user specified a model (first search): show requested model first, then one alternative; if no exact match, show all near matches (e.g. same brand)
      if (requestedModel) {
        const modelMatches = products.filter(p => this.productMatchesRequestedModel(p, requestedModel));
        const alternatives = products.filter(p => !this.productMatchesRequestedModel(p, requestedModel));
        const altCount = modelMatches.length > 0 ? 1 : 4;
        const ordered = [...modelMatches, ...alternatives.slice(0, altCount)];
        if (process.env.DEBUG === 'true') {
          console.log(`   [bike_ranker] Requested model: "${requestedModel}", model matches: ${modelMatches.length}, alternatives: ${ordered.length} (${modelMatches.length > 0 ? '1 alt' : 'near matches only'})`);
        }

        // AI-generated reasoning: when we have exact model match, explain first bike + alternative; when only near matches, one intro line
        let recommendationReasoning = '';
        let alternativeReasoning = '';
        let reasoningTokensUsed = 0;
        if (ordered.length > 0) {
          if (modelMatches.length === 0) {
            const lang = context.language || 'english';
            if (lang === 'malay') recommendationReasoning = 'Kami tidak ada model tersebut; berikut pilihan yang hampir sama atau jenama yang sama.';
            else if (lang === 'chinese') recommendationReasoning = '我们没有该型号；以下是相近或同品牌的选择。';
            else recommendationReasoning = 'We don\'t have that exact model; here are similar or same-brand options that might suit you.';
          } else {
          try {
            const lang = context.language || entities.language || 'english';
            const budgetStr = entities.budget ? `RM ${entities.budget}` : 'your budget';
            const firstBike = ordered[0];
            const firstPrice = firstBike.price != null ? `MYR ${Number(firstBike.price).toLocaleString()}` : '';
            const secondBike = ordered[1];
            const systemPrompt = 'You are a friendly motorcycle sales assistant. Return JSON with two short sentences in the user\'s language (English, Malay, or Chinese): model_reasoning = why the first bike is shown (they asked for this model but it may be a bit above budget). alternative_reasoning = why the second bike is recommended (e.g. fits their budget and is available in their area). Keep each 1 sentence, warm and helpful.';
            const userPrompt = `User's budget: ${budgetStr}. Area: ${entities.area || 'any'}. They asked for: ${requestedModel}. First bike: ${firstBike.name} (${firstPrice}). Second bike: ${secondBike ? secondBike.name + ' (MYR ' + Number(secondBike.price).toLocaleString() + ')' : 'none'}. Language: ${lang}. Return JSON: { "model_reasoning": "...", "alternative_reasoning": "..." }`;
            const completion = await openai.chat.completions.create({
              model: node.config.model || 'gpt-4o-mini',
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              temperature: 0.3,
              max_tokens: 150,
              response_format: { type: 'json_object' },
            });
            reasoningTokensUsed = completion.usage?.total_tokens || 0;
            const parsed = JSON.parse(completion.choices[0].message.content || '{}');
            recommendationReasoning = (parsed.model_reasoning || '').trim();
            alternativeReasoning = (parsed.alternative_reasoning || '').trim();
          } catch (err) {
            if (process.env.DEBUG === 'true') console.log('   [bike_ranker] Reasoning fallback:', err.message);
            const lang = context.language || 'english';
            if (lang === 'malay') {
              recommendationReasoning = 'Berdasarkan model pilihan anda, saya jumpa padanan — harganya sedikit melebihi bajet.';
              alternativeReasoning = 'Pilihan ini sesuai dengan bajet dan lokasi anda.';
            } else if (lang === 'chinese') {
              recommendationReasoning = '根据您选的型号我找到了匹配，但价格略超预算。';
              alternativeReasoning = '下面这款在您预算内且您所在地区有货。';
            } else {
              recommendationReasoning = 'Based on your preferred model I found a match — it\'s a bit above your budget.';
              alternativeReasoning = 'The option below fits your budget and is available in your area.';
            }
          }
          }
        }

        return {
          data: {
            products: ordered,
            recommendation_reasoning: recommendationReasoning,
            alternative_reasoning: alternativeReasoning,
            reasoning: modelMatches.length > 0
              ? `Showing your preferred model first, plus one alternative within your budget and area.`
              : `We don't have that model in stock; here's one option that fits your budget and location.`,
          },
          tokensUsed: reasoningTokensUsed,
          confidence: 0.9,
        };
      }

      const systemPrompt = node.config.system_prompt || 
        "Rank products by relevance to user's requirements. Consider: budget match, area availability, model preference, specifications, user intent.";
      const productsList = products.map((p, i) => {
        const features = p.features || {};
        const model = features.model || '';
        const engineSize = features.engineSize ? `${features.engineSize}cc` : '';
        const type = features.type || p.subcategory || '';
        const locations = features.locations ? `, Available in: ${features.locations.join(', ')}` : '';
        return `${i + 1}. ${p.name}${model ? ` ${model}` : ''} - ${p.currency || 'MYR'} ${p.price?.toLocaleString() || p.price}${engineSize ? `, ${engineSize}` : ''}${type ? `, ${type}` : ''}${locations}`;
      }).join('\n');

      const userPrompt = `User query: "${userQuery}"
User requirements: Budget: ${entities.budget || 'Not specified'}, Area: ${entities.area || 'Not specified'}, Model: ${entities.model || 'Not specified'}

Available products:
${productsList}

Rank products by relevance. Return JSON with: products (array with id/name, relevance_score, reasoning), overall_reasoning, confidence.`;

      try {
        const completion = await openai.chat.completions.create({
          model: node.config.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: node.config.temperature || 0.2,
          max_tokens: node.config.max_tokens || 400,
          response_format: { type: 'json_object' },
        });

        const content = JSON.parse(completion.choices[0].message.content);
        const tokensUsed = completion.usage.total_tokens;

        // Map rankings back to product objects (match by id, exact name, or brand+model)
        const topN = node.config.top_n || 5;
        const normalize = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        let rankedProducts = (content.products || []).map(ranked => {
          const name = (ranked.name || ranked.id || '').toString();
          const product = products.find(p =>
            p.id === ranked.id ||
            p.name === ranked.name ||
            normalize(p.name).includes(normalize(name)) ||
            normalize(name).includes(normalize(p.name)) ||
            `${p.brand} ${p.features?.model || ''}`.trim() === name
          );
          if (!product) return null;
          return {
            ...product,
            relevance_score: ranked.relevance_score ?? 0.5,
            reasoning: ranked.reasoning || 'Relevant product',
          };
        }).filter(Boolean).sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0))
          .slice(0, topN);

        // If LLM returned no matching names, show seed/search results anyway so user sees products
        if (rankedProducts.length === 0 && products.length > 0) {
          rankedProducts = products.slice(0, topN).map(p => ({
            ...p,
            relevance_score: 0.7,
            reasoning: 'Matches your search',
          }));
        }

        return {
          data: {
            products: rankedProducts,
            reasoning: content.overall_reasoning || content.reasoning,
          },
          tokensUsed,
          confidence: content.confidence || 0.7,
        };
      } catch (error) {
        console.error('Product ranking error:', error);
        // Fallback: return top products by popularity
        return {
          data: {
            products: products.slice(0, node.config.top_n || 5),
            reasoning: 'Fallback ranking by popularity',
          },
          tokensUsed: 0,
          confidence: 0.5,
        };
      }
    }

    // Generic ML: nodes with system_prompt that return JSON (clarification_handler, smart_question_generator, no_results_handler)
    if (node.config.system_prompt && node.config.next) {
      try {
        const systemPrompt = node.config.system_prompt;
        let userContent = typeof userQuery === 'string' ? userQuery : String(context.user_message || '');
        if (node.id === 'no_results_handler' && lastResult) {
          const searchInfo = lastResult.entities || context.metadata?.entities || {};
          userContent = `User's search had no results. They asked for: budget=${searchInfo.budget || 'any'}, area=${searchInfo.area || 'any'}, model=${searchInfo.model || 'any'}. User message: "${userContent}"`;
        }
        if (node.id === 'clarification_handler' && context.lastIntent) {
          userContent = `Last intent: ${context.lastIntent}. User message: "${userContent}". What is missing: budget, area, or model? Ask for ONE thing in a friendly way.`;
        }
        const completion = await openai.chat.completions.create({
          model: node.config.model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: node.config.temperature ?? 0.3,
          max_tokens: node.config.max_tokens || 200,
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
        const fallback = node.id === 'no_results_handler'
          ? { message: "Sorry, we don't have that right now. Would you like to try a different budget or area?" }
          : { clarification_message: "To recommend the best bikes, please share your budget (e.g. RM 5,000), area (e.g. Puchong), and preferred model if any." };
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
