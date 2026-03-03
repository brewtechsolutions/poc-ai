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
        return this.handleOptimizer(node, context);
      
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
        return this.handleModelDetails(node, context);
      
      default:
        return { data: context.lastResult?.data, tokensUsed: 0 };
    }
  }

  /**
   * Resolve user selection (number or name) to a product from lastShownProducts and return full details.
   */
  handleModelDetails(node, context) {
    const templateKey = node.config.template || 'model_detail_full';
    const language = context.language || context.lastResult?.data?.language || 'english';
    const lastShown = context.lastShownProducts || context.metadata?.lastShownProducts;
    const message = (context.user_message || '').trim().toLowerCase();

    let product = null;
    if (lastShown && Array.isArray(lastShown) && lastShown.length > 0) {
      const idx = context.lastResult?.data?.entities?.selected_index;
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

    if (!product) {
      const fallback = this.workflow.templates?.model_detail_full?.[language] || this.workflow.templates?.model_detail_full?.english;
      const msg = fallback ? 'Please reply with the number (e.g. 1, 2, 3) or the bike name from the list above.' : 'I couldn\'t find that model. Please reply with the number or name from the list.';
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
    
    if (process.env.DEBUG === 'true') {
      console.log(`   [Router] Intent: ${intent}, Route found: ${!!route}, Next: ${route?.next || node.config.fallback}`);
    }
    
    return {
      data: { intent, route },
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

        // If the requested model is a bit pricey (over budget), add alternatives at the bottom that fit budget+location
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
            take: node.config.alternatives_limit || 5,
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
          finalProducts = [...finalProducts, ...altFiltered];
        }
        finalProducts = finalProducts.slice(0, limit + (node.config.alternatives_limit || 5));
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
        finalProducts = filteredProducts;
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

      const systemPrompt = node.config.system_prompt || 
        "Rank products by relevance to user's requirements. Consider: budget match, area availability, model preference, specifications, user intent.";

      const entities = context.lastResult?.data?.entities || {};
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
    const language = context.language || context.lastResult?.data?.language || 'english';
    const entities = this.getEntitiesFromContext(context);
    const modelPart = (entities.model || '').trim();
    const brandPart = (entities.brand || '').trim();
    const requestedModel = !modelPart && !brandPart ? null
      : !modelPart ? brandPart
      : !brandPart ? modelPart
      : brandPart.toLowerCase() === modelPart.toLowerCase() ? modelPart
      : `${brandPart} ${modelPart}`.trim();

    // When showing bike recommendations: use "we don't have this model but have alternatives" if requested model not in list
    let effectiveTemplateKey = templateKey;
    if (templateKey === 'bike_recommendation' && requestedModel && products.length > 0) {
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

    // Format products generically (avoid repeating model in title if already in product.name)
    if (products.length > 0) {
      const productsText = products.map((product, i) => {
        const features = product.features || {};
        const model = features.model || '';
        const nameOnly = (product.name || '').trim();
        const modelInName = model && nameOnly.toLowerCase().includes(model.toLowerCase());
        const title = model && !modelInName ? `${nameOnly} ${model}` : nameOnly;
        const engineSize = features.engineSize ? `${features.engineSize}cc` : '';
        const type = features.type || product.subcategory || '';
        const locations = features.locations ? ` (${features.locations.join(', ')})` : '';
        return `${i + 1}. *${title}*\n   ${product.description || 'No description'}\n   Price: ${product.currency || 'MYR'} ${product.price?.toLocaleString() || product.price}${locations}\n   ${engineSize ? `Engine: ${engineSize}\n   ` : ''}${type ? `Type: ${type}\n   ` : ''}${product.inStock ? '✅ In Stock' : '❌ Out of Stock'}`;
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

    // When no products, placeholder might be empty; still pass formatted so downstream can use it
    if (products.length === 0 && (formatted.includes('{bikes}') || formatted.includes('{products}'))) {
      formatted = formatted.replace(/\{bikes\}\s*/g, '').replace(/\{products\}\s*/g, '').trim();
    }
    return {
      data: { formatted, products, response: formatted },
      tokensUsed: 0,
    };
  }

  handleOptimizer(node, context) {
    let response = context.lastResult?.data?.formatted || '';
    
    // Simple optimization: remove extra whitespace, compress
    response = response.replace(/\n{3,}/g, '\n\n').trim();
    
    // Check token count (rough estimate: 1 token ≈ 4 characters)
    const estimatedTokens = Math.ceil(response.length / 4);
    const maxTokens = node.config.max_tokens || 500;
    
    if (estimatedTokens > maxTokens) {
      // Truncate if too long
      response = response.substring(0, maxTokens * 4) + '...';
    }

    return {
      data: { optimized: response },
      tokensUsed: 0,
    };
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
