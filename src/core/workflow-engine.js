import fs from 'fs';
import path from 'path';
import prisma from '../config/database.js';
import openai, { TOKEN_CONFIG } from '../config/openai.js';
import ProductRecommender from '../utils/product-recommender.js';
import ImageProcessor from '../utils/image-processor.js';
import VoiceProcessor from '../utils/voice-processor.js';

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
      conversationHistory: [],
      workflowSteps: [],
      errors: [],
      allResults: [],
      finalResponse: null,
      visitedNodes: new Set(),
      maxIterations: 100,
      iterationCount: 0,
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
        return await this.handleNLP(node, context);
      
      case 'router':
        return this.handleRouter(node, context);
      
      case 'database':
        return await this.handleDatabase(node, context);
      
      case 'ml':
        return await this.handleML(node, context);
      
      case 'formatter':
        return this.handleFormatter(node, context);
      
      case 'optimizer':
        return await this.handleOptimizer(node, context);
      
      case 'handler':
        return await this.handleHandler(node, context);
      
      case 'escalation':
        return await this.handleEscalation(node, context);
      
      case 'action':
        return this.handleAction(node, context);
      
      case 'vision':
        return await this.handleVision(node, context);
      
      case 'speech':
        return await this.handleSpeech(node, context);
      
      case 'language_selector':
        return this.handleLanguageSelector(node, context);
      
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
      const modelName = (entities.model || '').toString().trim() || this.extractModelNameFromMessage(context.user_message || '');
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

  /**
   * Extract model name from messages like "i want ego s", "looking for yamaha ego", "ego s".
   */
  extractModelNameFromMessage(text) {
    const t = (text || '').trim();
    if (!t) return '';
    const lower = t.toLowerCase();
    const patterns = [
      /(?:i want|i'm looking for|looking for|do you have|got any|have you got|show me)\s+(.+)/i,
      /(?:can i (?:see|get)|would like)\s+(.+)/i,
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m && m[1]) return m[1].trim().replace(/\?|\.$/, '').slice(0, 80);
    }
    return t.length <= 80 ? t : t.slice(0, 80);
  }

  /**
   * Language selector: enforce "choose language first". If context.language is set, continue;
   * if user message is 1/2/3 or language name, set language and go to greeting; else prompt to choose.
   */
  handleLanguageSelector(node, context) {
    const config = node.config || {};
    const nextIfSet = config.next_if_set || 'message_classifier';
    const nextAfterSelect = config.next_after_select || 'greeting_handler';
    const nextPrompt = config.next_prompt || 'language_selection_prompt';

    const existingLanguage = context.language || context.metadata?.language;
    if (existingLanguage) {
      const normalized = String(existingLanguage).toLowerCase();
      if (['english', 'malay', 'chinese', 'en', 'bm', 'zh'].includes(normalized)) {
        context.language = normalized === 'en' ? 'english' : normalized === 'bm' ? 'malay' : normalized === 'zh' ? 'chinese' : normalized;
        if (process.env.DEBUG === 'true') {
          console.log(`   [LanguageSelector] Language already set: ${context.language}`);
        }
        return { data: { language: context.language }, tokensUsed: 0, next: nextIfSet };
      }
    }

    const raw = (context.user_message || '').trim();
    const msg = raw.toLowerCase();
    let selected = null;
    if (/^1$|^english$|^en$/i.test(msg)) selected = 'english';
    else if (/^2$|^malay$|^bm$|^bahasa$/i.test(msg)) selected = 'malay';
    else if (/^3$|^chinese$|^zh$|^中文$/i.test(msg) || msg.includes('chinese') || msg.includes('中文')) selected = 'chinese';

    if (selected) {
      context.language = selected;
      if (process.env.DEBUG === 'true') {
        console.log(`   [LanguageSelector] User selected language: ${selected}`);
      }
      return {
        data: { language: selected },
        tokensUsed: 0,
        next: nextAfterSelect,
      };
    }

    if (process.env.DEBUG === 'true') {
      console.log(`   [LanguageSelector] No language set, prompting user to choose`);
    }
    return {
      data: { needLanguageChoice: true },
      tokensUsed: 0,
      next: nextPrompt,
    };
  }

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
   * Detect "budget, area, model" reply (e.g. "RM 5,000, Puchong, Yamaha Ego") and parse without calling API.
   * Returns null if message doesn't match this format.
   * Handles comma inside budget (e.g. 5,000) by extracting budget first, then splitting the rest for area/model.
   */
  parseStructuredBudgetAreaModel(message, context = {}) {
    const raw = String(message).trim();
    if (!raw) return null;
    const hasRm = /\bRM\s*\d/i.test(raw) || /^\s*\d[\d,\s]*\d/.test(raw) || /^\s*\d+/.test(raw);
    if (!hasRm) return null;

    // Extract budget first so "5,000" isn't split into parts (RM 5,000 -> budget 5000)
    const budgetMatch = raw.match(/RM\s*([\d,]+)/i) || raw.match(/^([\d,]+)/);
    if (!budgetMatch) return null;
    const budget = budgetMatch[1].replace(/,/g, '');
    const afterBudget = raw.slice(raw.indexOf(budgetMatch[0]) + budgetMatch[0].length).replace(/^[\s,]+/, '').trim();
    if (!afterBudget) return null;

    // Rest is "Puchong, Yamaha Ego" or "Puchong" only
    const restParts = afterBudget.split(/\s*,\s*/).map(p => p.trim()).filter(Boolean);
    const area = restParts[0] || null;
    const model = restParts.length >= 2 ? restParts.slice(1).join(', ') : null;

    return {
      intent: 'bike_recommendation',
      entities: {
        budget: budget || undefined,
        area: area || undefined,
        location: area || undefined,
        model: model || undefined,
        brand: model || undefined,
      },
      language: context.language || 'english',
      confidence: 0.95,
    };
  }

  async handleNLP(node, context) {
    const message = context.user_message || context.lastResult?.data?.message;
    
    if (!message) {
      console.error('[NLP] No message found in context');
      return {
        data: {
          intent: 'general_question',
          entities: {},
          confidence: 0.3,
          requires_product_search: false,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.3,
        error: 'No message to process',
      };
    }

    // Rule-based: "got others?" / more options -> show more suggestions (reuse last search)
    const lower = message.toLowerCase().trim();
    if (/got others?|any others?|more options?|show more|other (bikes?|options?|suggestions?)|ada lain|还有别的|其他(的)?(选择|推荐)?/i.test(lower) && lower.length < 80) {
      if (process.env.DEBUG === 'true') console.log(`   [NLP] More options detected: more_options`);
      return {
        data: {
          intent: 'more_options',
          entities: context.entities || context.metadata?.entities || {},
          language: context.language || 'english',
          confidence: 0.9,
          requires_product_search: true,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.9,
      };
    }

    // Rule-based: "got Honda?" / "got Yamaha" etc. -> treat as brand/model request
    const gotBrandMatch = lower.match(/^got\s+([a-z0-9][a-z0-9\s\-]+)/i);
    if (gotBrandMatch && gotBrandMatch[1]) {
      const brandOrModel = gotBrandMatch[1].replace(/[?.!]+$/g, '').trim();
      if (brandOrModel.length >= 2 && brandOrModel.length <= 40) {
        if (process.env.DEBUG === 'true') {
          console.log(`   [NLP] Brand/model request detected via "got X": ${brandOrModel}`);
        }
        return {
          data: {
            intent: 'bike_recommendation',
            entities: { brand: brandOrModel, model: brandOrModel },
            language: context.language || 'english',
            confidence: 0.9,
            requires_product_search: true,
            requires_agent_escalation: false,
          },
          tokensUsed: 0,
          confidence: 0.9,
        };
      }
    }

    // Rule-based: keyword "arrange" or test ride phrases -> test_ride_request (show instructions + deposit), NOT agent transfer
    const arrangeOrTestRide = /\barrange\b/i.test(lower) || /arrange (a )?test ride|book (a )?test ride|test ride|ujian memandu|预约试驾|试驾/i.test(lower);
    if (arrangeOrTestRide && lower.length < 80) {
      if (process.env.DEBUG === 'true') console.log(`   [NLP] Arrange / test ride keyword -> test_ride_request (show instructions + deposit)`);
      return {
        data: {
          intent: 'test_ride_request',
          entities: {},
          language: context.language || 'english',
          confidence: 0.95,
          requires_product_search: false,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.95,
      };
    }

    // Rule-based: content words -> agent_request (transfer to real agent, one response, end session)
    const agentNode = this.nodes.get('agent_escalation');
    const contentWords = (agentNode?.config?.content_words || []).map(w => String(w).trim().toLowerCase()).filter(Boolean);
    if (contentWords.length > 0 && lower.length <= 80) {
      const matchesContentWord = contentWords.some(cw => lower === cw || lower.includes(cw));
      if (matchesContentWord) {
        if (process.env.DEBUG === 'true') console.log(`   [NLP] Content word matched -> agent_request (transfer to agent)`);
        return {
          data: {
            intent: 'agent_request',
            entities: {},
            language: context.language || 'english',
            confidence: 0.95,
            requires_product_search: false,
            requires_agent_escalation: true,
          },
          tokensUsed: 0,
          confidence: 0.95,
        };
      }
    }

    // Rule-based: "i want [model]" / "looking for [model]" etc. -> model_selection so we can look up in DB
    const extractedModel = this.extractModelNameFromMessage(message);
    const stopPhrases = /^(to |the |more |details?|price|info|about|how much|what is|test ride)/i;
    if (extractedModel.length >= 2 && extractedModel.length <= 60 && !/^\d+$/.test(extractedModel) && !stopPhrases.test(extractedModel)) {
      const looksLikeModelRequest = /^(i want|i'm looking for|looking for|do you have|got any|have you got|show me|can i see|would like)\s+/i.test(lower) || (/^(ego s|yamaha|honda|modenas|suzuki|kawasaki|ninja|rxz|lc135|ego|nmax|aerox)/i.test(lower) && lower.split(/\s+/).length <= 4);
      if (looksLikeModelRequest) {
        if (process.env.DEBUG === 'true') console.log(`   [NLP] Model lookup by name: "${extractedModel}"`);
        return {
          data: {
            intent: 'model_selection',
            entities: { model: extractedModel },
            language: context.language || 'english',
            confidence: 0.85,
            requires_product_search: false,
            requires_agent_escalation: false,
          },
          tokensUsed: 0,
          confidence: 0.85,
        };
      }
    }
    // Rule-based: user selected a model by number (1, 2, 3) or by name -> model_selection
    const lastShown = context.lastShownProducts || context.metadata?.lastShownProducts;
    if (lastShown && Array.isArray(lastShown) && lastShown.length > 0) {
      const trimmed = message.trim();
      const num = parseInt(trimmed, 10);
      if (Number.isInteger(num) && num >= 1 && num <= lastShown.length) {
        if (process.env.DEBUG === 'true') console.log(`   [NLP] Model selection by number: ${num}`);
        return {
          data: {
            intent: 'model_selection',
            entities: { selected_index: num },
            language: context.language || 'english',
            confidence: 0.95,
            requires_product_search: false,
            requires_agent_escalation: false,
          },
          tokensUsed: 0,
          confidence: 0.95,
        };
      }
      const matchByName = lastShown.find(p =>
        (p.name && (p.name).toLowerCase().includes(lower)) ||
        (p.brand && (p.brand).toLowerCase().includes(lower)) ||
        (p.features?.model && String(p.features.model).toLowerCase().includes(lower))
      );
      if (matchByName && lower.length < 80) {
        if (process.env.DEBUG === 'true') console.log(`   [NLP] Model selection by name`);
        return {
          data: {
            intent: 'model_selection',
            entities: {},
            language: context.language || 'english',
            confidence: 0.9,
            requires_product_search: false,
            requires_agent_escalation: false,
          },
          tokensUsed: 0,
          confidence: 0.9,
        };
      }
    }

    // Rule-based: "more detail" -> prompt which bike they want details on
    if (/more detail|tell me more|full specs?|full details?|详细|maklumat lanjut/i.test(lower) && lower.length < 60) {
      if (process.env.DEBUG === 'true') console.log(`   [NLP] More details detected: more_details`);
      return {
        data: {
          intent: 'more_details',
          entities: {},
          language: context.language || 'english',
          confidence: 0.9,
          requires_product_search: false,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.9,
      };
    }

    // Rule-based: recognize "RM X, Location, Model" so user's reply is accepted and goes to bike search
    const structured = this.parseStructuredBudgetAreaModel(message, context);
    if (structured) {
      if (process.env.DEBUG === 'true') {
        console.log(`   [NLP] Structured reply detected: bike_recommendation, budget=${structured.entities.budget}, area=${structured.entities.area}, model=${structured.entities.model}`);
      }
      return {
        data: {
          intent: structured.intent,
          entities: structured.entities,
          language: structured.language,
          confidence: structured.confidence,
          requires_product_search: true,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: structured.confidence,
      };
    }

    // Rule-based: budget-only messages like "I only have the budget of RM5,000"
    const budgetOnlyMatch = message.match(/\b(?:budget|bajet)[^0-9]{0,15}RM\s*([\d,]+)/i) ||
                            message.match(/\bRM\s*([\d,]+)[^a-zA-Z0-9]{0,10}(?:budget|bajet)\b/i);
    if (budgetOnlyMatch) {
      const budgetStr = (budgetOnlyMatch[1] || '').replace(/,/g, '');
      if (budgetStr) {
        if (process.env.DEBUG === 'true') {
          console.log(`   [NLP] Budget-only message detected, budget=${budgetStr}`);
        }
        return {
          data: {
            intent: 'bike_recommendation',
            entities: {
              budget: budgetStr,
            },
            language: context.language || 'english',
            confidence: 0.9,
            requires_product_search: true,
            requires_agent_escalation: false,
          },
          tokensUsed: 0,
          confidence: 0.9,
        };
      }
    }
    
    const systemPrompt = node.config.system_prompt || 
      "You are a sales assistant. Extract intent, language and entities from user messages.";
    
    const userPrompt = `Extract intent, language and entities from this message: "${message}"\n\nReturn JSON with: language (english/malay/chinese), intent, entities (object), confidence (0-1), requires_product_search (boolean), requires_agent_escalation (boolean)`;

    try {
      if (process.env.DEBUG === 'true') {
        console.log(`   [NLP] Processing message: "${message.substring(0, 50)}..."`);
      }

      const completion = await openai.chat.completions.create({
        model: node.config.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: node.config.temperature || TOKEN_CONFIG.TEMPERATURE.STRICT,
        max_tokens: node.config.max_tokens || 150,
        response_format: { type: 'json_object' },
      });

      const content = JSON.parse(completion.choices[0].message.content);
      const tokensUsed = completion.usage.total_tokens;

      const detectedLanguage = context.language || content.language || 'english';

      if (process.env.DEBUG === 'true') {
        console.log(`   [NLP] Language: ${detectedLanguage}, Intent: ${content.intent}, Confidence: ${content.confidence || 0.5}`);
      }

      return {
        data: {
          intent: content.intent,
          entities: content.entities || {},
          // Never override existing conversation language with a new guess
          language: detectedLanguage,
          confidence: content.confidence || 0.5,
          requires_product_search: content.requires_product_search || false,
          requires_agent_escalation: content.requires_agent_escalation || false,
        },
        tokensUsed,
        confidence: content.confidence || 0.5,
      };
    } catch (error) {
      console.error('❌ NLP processing error:', error);
      console.error('   Error details:', error.message);
      if (error.response) {
        console.error('   API response:', error.response.data);
      }
      
      return {
        data: {
          intent: 'general_question',
          entities: {},
          language: 'english',
          confidence: 0.3,
          requires_product_search: false,
          requires_agent_escalation: false,
        },
        tokensUsed: 0,
        confidence: 0.3,
        error: error.message,
      };
    }
  }

  handleRouter(node, context) {
    const intent = context.lastResult?.data?.intent;
    const route = node.config.routes.find(r => r.intent === intent);
    // Pass through entities from classifier/NLP so model_details_handler gets selected_index
    const entities = context.lastResult?.data?.entities;
    
    if (process.env.DEBUG === 'true') {
      console.log(`   [Router] Intent: ${intent}, Route found: ${!!route}, Next: ${route?.next || node.config.fallback}`);
    }
    
    return {
      data: { intent, route, entities: entities || {} },
      tokensUsed: 0,
      next: route?.next || node.config.fallback,
    };
  }

  async handleDatabase(node, context) {
    const operation = node.config.operation;
    const lastResult = context.lastResult?.data;

    try {
      switch (operation) {
        case 'semantic_search':
          return await this.semanticProductSearch(node, context, lastResult);
        
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

  async semanticProductSearch(node, context, lastResult) {
    const query = context.user_message || '';
    // Use last search criteria when user says "got others?" / more_options (entities from session)
    const entities = lastResult?.entities || context.entities || context.metadata?.entities || {};
    const category = node.config.category || entities.category || null;
    const isMoreOptions = context.lastIntent === 'more_options';

    // MODEL-FIRST: when user specified a model/brand, search by model first, then apply budget and location
    const modelSearchText = (entities.model || entities.brand || '').toString().trim();
    const hasRequestedModel = !isMoreOptions && modelSearchText.length > 0;
    const primarySearchText = modelSearchText || query;
    const searchTerms = primarySearchText.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const budgetNum = entities.budget ? parseFloat(entities.budget) : null;

    const limit = isMoreOptions
      ? (node.config.more_options_limit || 10)
      : (node.config.limit || 15);

    let finalProducts = [];

    if (hasRequestedModel) {
      // 1) Model first: query only by model/brand/name (no budget, no area in DB query)
      const modelOnlyConditions = {
        AND: [
          { active: true },
          { inStock: true },
          {
            OR: [
              { name: { contains: primarySearchText, mode: 'insensitive' } },
              { brand: { contains: primarySearchText, mode: 'insensitive' } },
              { subcategory: { contains: entities.type || primarySearchText, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
              { category: { contains: category || query, mode: 'insensitive' } },
              { tags: { hasSome: searchTerms } },
            ],
          },
        ],
      };

      const modelMatches = await prisma.product.findMany({
        where: modelOnlyConditions,
        take: limit,
        orderBy: { popularity: 'desc' },
      });

      // 2) Then filter by budget (in memory)
      let afterBudget = modelMatches;
      if (budgetNum != null) {
        afterBudget = modelMatches.filter(p => p.price <= budgetNum);
      }

      // 3) Then filter by area/location (in memory)
      let afterArea = afterBudget;
      if (entities.area) {
        afterArea = afterBudget.filter(p => {
          const locations = p.features?.locations || [];
          return locations.length === 0 || locations.some(loc =>
            loc.toLowerCase().includes(entities.area.toLowerCase())
          );
        });
        if (afterArea.length === 0) afterArea = afterBudget;
      }

      // Model is priority: always return model matches so the requested bike is shown first.
      // If some model matches fit budget+area, use those first; then add the rest of the model matches.
      if (modelMatches.length > 0) {
        const modelIds = new Set(modelMatches.map(p => p.id));
        const inBudgetAndArea = afterArea.filter(p => modelIds.has(p.id));
        // Requested model first (those in budget+area, then the rest of model matches)
        finalProducts = [...inBudgetAndArea, ...modelMatches.filter(p => !inBudgetAndArea.find(m => m.id === p.id))];

        // If the requested model is a bit pricey (over budget), add exactly ONE alternative that fits budget+location
        const modelIsPricey = budgetNum != null && inBudgetAndArea.length === 0;
        if (modelIsPricey) {
          const altConditions = {
            AND: [
              { active: true },
              { inStock: true },
              { price: { lte: budgetNum } },
              { id: { notIn: [...modelIds] } },
            ],
          };
          const alternatives = await prisma.product.findMany({
            where: altConditions,
            take: 10,
            orderBy: { popularity: 'desc' },
          });
          let altFiltered = alternatives;
          if (entities.area) {
            altFiltered = alternatives.filter(p => {
              const locations = p.features?.locations || [];
              return locations.length === 0 || locations.some(loc =>
                loc.toLowerCase().includes(entities.area.toLowerCase())
              );
            });
            if (altFiltered.length === 0) altFiltered = alternatives;
          }
          finalProducts = [...finalProducts, ...altFiltered.slice(0, 1)];
        } else {
          // Model in budget: still add exactly one alternative by budget+location
          const altConditions = {
            AND: [
              { active: true },
              { inStock: true },
              { id: { notIn: [...modelIds] } },
            ],
          };
          if (budgetNum != null) altConditions.AND.push({ price: { lte: budgetNum } });
          const alternatives = await prisma.product.findMany({
            where: altConditions,
            take: 10,
            orderBy: { popularity: 'desc' },
          });
          let altFiltered = alternatives;
          if (entities.area) {
            altFiltered = alternatives.filter(p => {
              const locations = p.features?.locations || [];
              return locations.length === 0 || locations.some(loc =>
                loc.toLowerCase().includes(entities.area.toLowerCase())
              );
            });
            if (altFiltered.length === 0) altFiltered = alternatives;
          }
          finalProducts = [...finalProducts, ...altFiltered.slice(0, 1)];
        }
        finalProducts = finalProducts.slice(0, 4);
      } else {
        // No exact match: search whole DB for "nearly same" (same brand or any word in model name)
        const modelWords = primarySearchText.split(/\s+/).filter(w => w.length >= 2).map(w => w.trim());
        if (modelWords.length > 0) {
          const orConditions = [];
          for (const word of modelWords) {
            orConditions.push({ name: { contains: word, mode: 'insensitive' } });
            orConditions.push({ brand: { contains: word, mode: 'insensitive' } });
            orConditions.push({ description: { contains: word, mode: 'insensitive' } });
          }
          const nearMatchConditions = {
            AND: [
              { active: true },
              { inStock: true },
              { OR: orConditions },
            ],
          };
          const nearMatches = await prisma.product.findMany({
            where: nearMatchConditions,
            take: limit,
            orderBy: { popularity: 'desc' },
          });
          let nearFiltered = nearMatches;
          if (budgetNum != null) {
            nearFiltered = nearMatches.filter(p => p.price <= budgetNum);
            if (nearFiltered.length === 0) nearFiltered = nearMatches;
          }
          if (entities.area) {
            const byArea = nearFiltered.filter(p => {
              const locations = p.features?.locations || [];
              return locations.length === 0 || locations.some(loc =>
                loc.toLowerCase().includes(entities.area.toLowerCase())
              );
            });
            if (byArea.length > 0) nearFiltered = byArea;
          }
          finalProducts = nearFiltered.slice(0, 4);
        }
      }
    }

    if (!hasRequestedModel || finalProducts.length === 0) {
      // No requested model, or no model matches: use original logic (budget + area in query)
      const baseConditions = {
        AND: [
          { active: true },
          { inStock: true },
        ],
      };

      if (!isMoreOptions) {
        baseConditions.AND.push({
          OR: [
            { name: { contains: primarySearchText, mode: 'insensitive' } },
            { brand: { contains: primarySearchText, mode: 'insensitive' } },
            { subcategory: { contains: entities.type || primarySearchText, mode: 'insensitive' } },
            { description: { contains: query, mode: 'insensitive' } },
            { category: { contains: category || query, mode: 'insensitive' } },
            { tags: { hasSome: searchTerms } },
          ],
        });
      }

      if (!isMoreOptions && budgetNum != null) {
        baseConditions.AND.push({ price: { lte: budgetNum } });
      }

      const products = await prisma.product.findMany({
        where: baseConditions,
        take: limit,
        orderBy: { popularity: 'desc' },
      });

      let filteredProducts = products;
      if (entities.area) {
        filteredProducts = products.filter(p => {
          const locations = p.features?.locations || [];
          return locations.length === 0 || locations.some(loc =>
            loc.toLowerCase().includes(entities.area.toLowerCase())
          );
        });
        if (filteredProducts.length === 0) filteredProducts = products;
      }

      if (hasRequestedModel && finalProducts.length === 0) {
        finalProducts = filteredProducts.slice(0, 1);
      } else if (!hasRequestedModel) {
        finalProducts = filteredProducts;
      }
    }

    const useFallbackWhenEmpty = node.config.use_fallback_when_empty === true;
    if ((!finalProducts || finalProducts.length === 0) && useFallbackWhenEmpty) {
      const fallbackLimit = node.config.fallback_limit || 5;
      const fallbackProducts = await prisma.product.findMany({
        where: { active: true, inStock: true },
        orderBy: { popularity: 'desc' },
        take: fallbackLimit,
      });
      finalProducts = fallbackProducts;
    }

    return {
      data: { products: finalProducts || [] },
      tokensUsed: 0,
      found: (finalProducts && finalProducts.length) > 0,
    };
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

  /**
   * Get entities from the most recent node that produced them (e.g. language_detector).
   * context_collector runs after intent_router, which does not pass entities; they live in an earlier result.
   */
  getEntitiesFromContext(context) {
    const results = context.allResults || [];
    for (let i = results.length - 1; i >= 0; i--) {
      const entities = results[i]?.data?.entities;
      if (entities && typeof entities === 'object' && Object.keys(entities).length > 0) {
        return entities;
      }
    }
    return context.lastResult?.data?.entities || {};
  }

  async handleML(node, context) {
    const lastResult = context.lastResult?.data;
    const products = lastResult?.products || [];
    const userQuery = context.user_message;

    // Context collector: if user already gave budget + area, go to bike_search (routing via config.next_complete in getNextNode)
    if (node.id === 'context_collector') {
      const entities = this.getEntitiesFromContext(context);
      const hasBudget = !!(entities.budget || entities.price_range);
      const hasArea = !!(entities.area || entities.location);
      const contextComplete = hasBudget && hasArea;
      if (process.env.DEBUG === 'true') {
        console.log(`   [ML/context_collector] contextComplete=${contextComplete}, hasBudget=${hasBudget}, hasArea=${hasArea}`);
      }
      return {
        data: {
          ...lastResult,
          entities,
          contextComplete,
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

  /** Check if any product matches the requested model/brand (e.g. "Yamaha Ego S"). */
  productMatchesRequestedModel(product, requestedModel) {
    if (!requestedModel || typeof requestedModel !== 'string') return true;
    const n = (s) => (s || '').toLowerCase().trim();
    const key = n(requestedModel);
    const name = n(product.name);
    const brand = n(product.brand || '');
    const model = n(product.features?.model || '');
    return name.includes(key) || (brand + ' ' + model).trim().includes(key) || model.includes(key);
  }

  handleFormatter(node, context) {
    const products = context.lastResult?.data?.products || [];
    const templateKey = node.config.template;
    const lastIntent = context.lastIntent || context.lastResult?.data?.intent;
    const language = context.language || context.lastResult?.data?.language || 'english';
    const entities = this.getEntitiesFromContext(context);
    const modelPart = (entities.model || '').trim();
    const brandPart = (entities.brand || '').trim();
    const requestedModel = !modelPart && !brandPart ? null
      : !modelPart ? brandPart
      : !brandPart ? modelPart
      : brandPart.toLowerCase() === modelPart.toLowerCase() ? modelPart
      : `${brandPart} ${modelPart}`.trim();

    // When showing bike recommendations: use "we don't have this model but have alternatives" if requested model not in list.
    // BUT for "more_options" (user said "got others?"), we should not repeat "we don't have this model" – just show more bikes.
    let effectiveTemplateKey = templateKey;
    if (
      templateKey === 'bike_recommendation' &&
      requestedModel &&
      products.length > 0 &&
      lastIntent !== 'more_options'
    ) {
      const hasRequestedModel = products.some(p => this.productMatchesRequestedModel(p, requestedModel));
      if (!hasRequestedModel && this.workflow.templates.no_model_alternatives) {
        effectiveTemplateKey = 'no_model_alternatives';
      }
    }

    // Get template - support multi-language
    let template = '';
    if (typeof this.workflow.templates[effectiveTemplateKey] === 'object') {
      template = this.workflow.templates[effectiveTemplateKey][language] ||
                 this.workflow.templates[effectiveTemplateKey]['english'] ||
                 '';
    } else {
      template = this.workflow.templates[effectiveTemplateKey] || '';
    }

    let formatted = template;
    if (effectiveTemplateKey === 'no_model_alternatives' && requestedModel) {
      formatted = formatted.replace(/\{model\}/g, requestedModel);
    }

    // Recommendation reasoning (AI-generated when user asked for a specific model: "model match a bit pricey, below one fits budget")
    const recommendationReasoning = context.lastResult?.data?.recommendation_reasoning;
    formatted = formatted.replace(/\{recommendation_reasoning\}\n?\n?/g, recommendationReasoning ? recommendationReasoning + '\n\n' : '\n');

    // Format products generically (avoid repeating model in title if already in product.name)
    if (products.length > 0) {
      const alternativeReasoning = context.lastResult?.data?.alternative_reasoning;
      const productsText = products.map((product, i) => {
        const features = product.features || {};
        const model = features.model || '';
        const nameOnly = (product.name || '').trim();
        const modelInName = model && nameOnly.toLowerCase().includes(model.toLowerCase());
        const title = model && !modelInName ? `${nameOnly} ${model}` : nameOnly;
        const engineSize = features.engineSize ? `${features.engineSize}cc` : '';
        const type = features.type || product.subcategory || '';
        const locations = features.locations ? ` (${features.locations.join(', ')})` : '';
        const block = `${i + 1}. *${title}*\n   ${product.description || 'No description'}\n   Price: ${product.currency || 'MYR'} ${product.price?.toLocaleString() || product.price}${locations}\n   ${engineSize ? `Engine: ${engineSize}\n   ` : ''}${type ? `Type: ${type}\n   ` : ''}${product.inStock ? '✅ In Stock' : '❌ Out of Stock'}`;
        if (i === 1 && alternativeReasoning) {
          return `💡 ${alternativeReasoning}\n\n${block}`;
        }
        return block;
      }).join('\n\n');
      
      formatted = formatted.replace('{bikes}', productsText);
      formatted = formatted.replace('{products}', productsText);
    }

    // Replace other placeholders
    if (node.config.include_context && context.lastResult?.data?.questions) {
      const questions = Array.isArray(context.lastResult.data.questions) 
        ? context.lastResult.data.questions.join('\n')
        : context.lastResult.data.questions;
      formatted = formatted.replace('{questions}', questions);
    }

    // Replace placeholders from lastResult.data (e.g. clarification_message, message from ML nodes)
    if (node.config.include_context && context.lastResult?.data && typeof context.lastResult.data === 'object') {
      const data = context.lastResult.data;
      for (const [key, value] of Object.entries(data)) {
        if (value != null && key !== 'products' && key !== 'formatted' && key !== 'response') {
          const str = typeof value === 'string' ? value : (Array.isArray(value) ? value.join('\n') : String(value));
          formatted = formatted.replace(new RegExp('\\{' + key + '\\}', 'g'), str);
        }
      }
    }

    // When no products, placeholder might be empty; still pass formatted so downstream can use it
    if (products.length === 0 && (formatted.includes('{bikes}') || formatted.includes('{products}'))) {
      formatted = formatted.replace(/\{bikes\}\s*/g, '').replace(/\{products\}\s*/g, '').trim();
    }
    return {
      data: { formatted, products, response: formatted },
      tokensUsed: 0,
    };
  }

  async handleOptimizer(node, context) {
    // Take whatever the previous node formatted as the bot reply
    let response = context.lastResult?.data?.formatted ||
                   context.lastResult?.data?.response ||
                   context.lastResult?.data?.finalResponse ||
                   '';
    response = (response || '').toString().trim();

    const lastIntent = context.lastIntent || context.lastResult?.data?.intent;
    const isGreetingFlow = lastIntent === 'greeting' || context.lastResult?.data?.intent === 'greeting';
    const isLanguageSelectionFlow = context.lastResult?.data?.needLanguageChoice === true;

    // For pure template messages (greeting and language selection), skip OpenAI to avoid token usage
    if (!response || isGreetingFlow || isLanguageSelectionFlow) {
      // Simple whitespace cleanup only, no tokens
      const cleaned = response.replace(/\n{3,}/g, '\n\n').trim();
      return {
        data: { optimized: cleaned, finalResponse: cleaned },
        tokensUsed: 0,
      };
    }

    const systemPrompt = node.config.system_prompt ||
      'You are a friendly sales assistant. Rewrite the reply to sound natural, clear and concise.';

    try {
      const completion = await openai.chat.completions.create({
        model: node.config.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: response },
        ],
        temperature: node.config.temperature ?? TOKEN_CONFIG.TEMPERATURE.STRICT,
        max_tokens: node.config.max_tokens || 600,
      });

      const optimized = (completion.choices[0].message.content || '').trim();
      const tokensUsed = completion.usage?.total_tokens || 0;

      // Fallback to original if something went wrong with content
      const finalText = optimized || response;

      return {
        data: { optimized: finalText, finalResponse: finalText },
        tokensUsed,
      };
    } catch (error) {
      console.error('[Optimizer] Error optimizing response:', error.message);
      // Fallback to old simple trimming behavior
      let fallback = response.replace(/\n{3,}/g, '\n\n').trim();
      const estimatedTokens = Math.ceil(fallback.length / 4);
      const maxTokens = node.config.max_tokens || 600;
      if (estimatedTokens > maxTokens) {
        fallback = fallback.substring(0, maxTokens * 4) + '...';
      }
      return {
        data: { optimized: fallback, finalResponse: fallback },
        tokensUsed: 0,
      };
    }
  }

  async handleHandler(node, context) {
    const templateKey = node.config.template;
    const language = context.language || context.lastResult?.data?.language || 'english';
    
    // Get template - support multi-language
    let template = '';
    if (typeof this.workflow.templates[templateKey] === 'object') {
      template = this.workflow.templates[templateKey][language] || 
                 this.workflow.templates[templateKey]['english'] || 
                 '';
    } else {
      template = this.workflow.templates[templateKey] || '';
    }
    
    // Replace placeholders if needed
    let response = template;
    if (node.config.include_context && context.lastResult?.data) {
      const data = context.lastResult.data;
      if (data.questions) {
        const questions = Array.isArray(data.questions) ? data.questions.join('\n') : data.questions;
        response = response.replace('{questions}', questions);
      }
    }
    
    if (process.env.DEBUG === 'true') {
      console.log(`   [Handler] Template: ${templateKey}, Language: ${language}, Response length: ${response.length}`);
    }
    
    return {
      data: { 
        response: response,
        formatted: response,
        // Also set as finalResponse for easier extraction
        finalResponse: response,
        // Mark greeting so optimizer keeps the structured 3-item message (no rewrite)
        ...(templateKey === 'greeting' ? { intent: 'greeting' } : {}),
      },
      tokensUsed: 0,
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

  handleAction(node, context) {
    // Try multiple sources for the response - check in order of priority
    let response = null;
    
    // Priority 1: Check last result (most recent)
    const lastResult = context.lastResult?.data;
    if (lastResult) {
      response = lastResult.optimized || 
                 lastResult.response || 
                 lastResult.formatted ||
                 lastResult.finalResponse;
    }
    
    // Priority 2: Walk backwards through workflow steps to find any response
    if (!response && context.workflowSteps) {
      for (let i = context.workflowSteps.length - 1; i >= 0; i--) {
        const step = context.workflowSteps[i];
        // Check if we have access to the actual result data
        // We need to check the execution context's stored results
        const stepData = step.result?.data;
        if (stepData) {
          response = stepData.optimized || 
                     stepData.response || 
                     stepData.formatted ||
                     stepData.finalResponse;
          if (response) break;
        }
      }
    }
    
    // Priority 3: Check all previous results in execution context
    if (!response) {
      // Look through all stored results
      const allResults = context.allResults || [];
      for (let i = allResults.length - 1; i >= 0; i--) {
        const resultData = allResults[i]?.data;
        if (resultData) {
          response = resultData.optimized || 
                     resultData.response || 
                     resultData.formatted ||
                     resultData.finalResponse;
          if (response) break;
        }
      }
    }

    // Priority 4: Use template based on intent and language
    if (!response) {
      const intent = context.lastResult?.data?.intent || 'greeting';
      const language = context.language || context.lastResult?.data?.language || 'english';
      
      // Try to get template
      const templateKey = intent === 'greeting' ? 'greeting' : `${intent}_response`;
      let template = '';
      
      if (typeof this.workflow.templates[templateKey] === 'object') {
        template = this.workflow.templates[templateKey][language] || 
                   this.workflow.templates[templateKey]['english'] || 
                   '';
      } else {
        template = this.workflow.templates[templateKey] || '';
      }
      
      // Fallback to greeting template
      if (!template && typeof this.workflow.templates.greeting === 'object') {
        template = this.workflow.templates.greeting[language] || 
                   this.workflow.templates.greeting['english'] || 
                   '';
      } else if (!template) {
        template = this.workflow.templates.greeting || '';
      }
      
      response = template || 'I apologize, I couldn\'t process that request. Please try rephrasing your question.';
    }

    if (process.env.DEBUG === 'true') {
      console.log(`[Action] Final response: ${response?.substring(0, 100)}...`);
      console.log(`[Action] Response source: ${response ? 'found' : 'NOT FOUND'}`);
      console.log(`[Action] Last result keys:`, context.lastResult?.data ? Object.keys(context.lastResult.data) : 'none');
    }
    
    return {
      data: { finalResponse: response },
      tokensUsed: 0,
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
