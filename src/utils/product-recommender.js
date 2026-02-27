import openai, { TOKEN_CONFIG } from '../config/openai.js';
import prisma from '../config/database.js';

/**
 * Smart Product Recommender
 * Uses AI to find and rank the most relevant products
 */
class ProductRecommender {
  /**
   * Get product recommendations based on user query
   */
  async recommend(query, userContext = {}) {
    // Step 1: Search products in database
    const products = await this.searchProducts(query);
    
    if (products.length === 0) {
      return {
        products: [],
        confidence: 0,
        reasoning: 'No products found matching your query.',
      };
    }

    // Step 2: Rank products using AI
    const ranked = await this.rankProducts(query, products, userContext);

    // Step 3: Filter by minimum relevance
    const minRelevance = 0.6;
    const relevant = ranked.products.filter(p => 
      p.relevance_score >= minRelevance
    );

    if (relevant.length === 0) {
      return {
        products: [],
        confidence: ranked.confidence,
        reasoning: 'I found products, but none are highly relevant to your query. Would you like to see them anyway, or refine your search?',
        fallbackProducts: ranked.products.slice(0, 3),
      };
    }

    return {
      products: relevant.slice(0, 3), // Top 3
      confidence: ranked.confidence,
      reasoning: ranked.reasoning,
    };
  }

  /**
   * Search products in database
   */
  async searchProducts(query, limit = 10) {
    const searchTerms = query.toLowerCase().split(' ').filter(t => t.length > 2);

    const products = await prisma.product.findMany({
      where: {
        AND: [
          { active: true },
          { inStock: true },
          {
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
              { category: { contains: query, mode: 'insensitive' } },
              { tags: { hasSome: searchTerms } },
            ],
          },
        ],
      },
      take: limit,
      orderBy: [
        { popularity: 'desc' },
        { createdAt: 'desc' },
      ],
    });

    return products;
  }

  /**
   * Rank products by relevance using AI
   */
  async rankProducts(query, products, userContext) {
    if (products.length === 0) {
      return { products: [], confidence: 0, reasoning: 'No products to rank.' };
    }

    // Prepare product list for AI
    const productsList = products.map((p, index) => {
      return `${index + 1}. ${p.name} (${p.category})
   Description: ${p.description || 'No description'}
   Price: $${p.price}
   Features: ${p.tags?.join(', ') || 'N/A'}
   In Stock: ${p.inStock ? 'Yes' : 'No'}
   Popularity: ${p.popularity}`;
    }).join('\n\n');

    const systemPrompt = `You are a product recommendation expert. Analyze products and rank them by relevance to the user's query. Consider:
- Exact name matches
- Category relevance
- Feature matches
- Price appropriateness
- User intent

Return JSON with: {products: [{index, relevance_score (0-1), reasoning}], confidence (0-1), overall_reasoning}`;

    const userPrompt = `User query: "${query}"
${userContext.preferences ? `User preferences: ${JSON.stringify(userContext.preferences)}` : ''}

Available products:
${productsList}

Rank products by relevance. Return top 3 most relevant with scores and reasoning.`;

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: TOKEN_CONFIG.TEMPERATURE.BALANCED,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      });

      const result = JSON.parse(completion.choices[0].message.content);
      const tokensUsed = completion.usage.total_tokens;

      // Map rankings back to product objects
      const rankedProducts = result.products
        .map(ranked => {
          const product = products[ranked.index - 1]; // Convert 1-based to 0-based
          if (!product) return null;
          
          return {
            ...product,
            relevance_score: ranked.relevance_score || 0.5,
            reasoning: ranked.reasoning || 'Relevant product',
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.relevance_score - a.relevance_score);

      return {
        products: rankedProducts,
        confidence: result.confidence || 0.7,
        reasoning: result.overall_reasoning || 'Products ranked by relevance',
        tokensUsed,
      };
    } catch (error) {
      console.error('Product ranking error:', error);
      
      // Fallback: return products sorted by popularity
      return {
        products: products.slice(0, 3).map(p => ({
          ...p,
          relevance_score: 0.5,
          reasoning: 'Fallback ranking by popularity',
        })),
        confidence: 0.5,
        reasoning: 'Used fallback ranking method',
        tokensUsed: 0,
      };
    }
  }

  /**
   * Get product by ID
   */
  async getProductById(productId) {
    return await prisma.product.findUnique({
      where: { id: productId },
    });
  }

  /**
   * Get products by category
   */
  async getProductsByCategory(category, limit = 10) {
    return await prisma.product.findMany({
      where: {
        category: { contains: category, mode: 'insensitive' },
        active: true,
        inStock: true,
      },
      take: limit,
      orderBy: { popularity: 'desc' },
    });
  }
}

export default new ProductRecommender();
