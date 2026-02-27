import readline from 'readline';
import WorkflowEngine from '../core/workflow-engine.js';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Terminal Test Interface for Sales AI Chatbot
 * Fast debugging and testing without WhatsApp
 */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

class TerminalChatbot {
  constructor() {
    this.workflowEngine = new WorkflowEngine();
    this.conversationId = `test-${Date.now()}`;
    this.userPhone = '+1234567890';
    this.context = {
      phone_number: this.userPhone,
      conversation_id: this.conversationId,
    };
  }

  async processMessage(userMessage) {
    console.log('\n🤖 Processing...\n');

    const context = {
      ...this.context,
      user_message: userMessage,
      metadata: {
        phone_number: this.userPhone,
        message_type: 'text',
        timestamp: new Date().toISOString(),
      },
    };

    try {
      const result = await this.workflowEngine.execute(context);
      
      const response = result.lastResult?.data?.finalResponse || 
                      result.lastResult?.data?.optimized ||
                      result.lastResult?.data?.response ||
                      'I apologize, I couldn\'t process that request.';

      // Display results
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📤 RESPONSE:');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(response);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      
      // Debug info
      if (process.env.DEBUG === 'true') {
        console.log('\n🔍 DEBUG INFO:');
        console.log(`Intent: ${result.lastResult?.data?.intent || 'N/A'}`);
        console.log(`Confidence: ${result.lastResult?.data?.confidence || 'N/A'}`);
        console.log(`Tokens Used: ${result.tokensUsed || 0}`);
        console.log(`Response Time: ${result.responseTime || 0}ms`);
        if (result.lastResult?.data?.products) {
          console.log(`Products Found: ${result.lastResult.data.products.length}`);
        }
        console.log('');
      }

      return response;
    } catch (error) {
      console.error('❌ Error:', error.message);
      console.error(error.stack);
      return 'I encountered an error. Please try again.';
    }
  }

  start() {
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║   🛍️  Sales AI Chatbot - Terminal Test Mode   ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log('\nType your messages (type "exit" or "quit" to stop)\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    this.askQuestion();
  }

  askQuestion() {
    rl.question('👤 You: ', async (answer) => {
      if (answer.toLowerCase() === 'exit' || answer.toLowerCase() === 'quit') {
        console.log('\n👋 Goodbye! Thanks for testing!\n');
        rl.close();
        process.exit(0);
      }

      if (answer.trim()) {
        await this.processMessage(answer);
      }

      this.askQuestion();
    });
  }
}

// Start the terminal chatbot
const chatbot = new TerminalChatbot();
chatbot.start();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Goodbye! Thanks for testing!\n');
  rl.close();
  process.exit(0);
});
