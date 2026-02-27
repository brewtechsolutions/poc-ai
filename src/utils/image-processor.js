import openai from '../config/openai.js';
import axios from 'axios';

/**
 * Image Processor for product identification and analysis
 */
class ImageProcessor {
  /**
   * Process image and extract product information
   */
  async processImage(imageUrl) {
    try {
      // Download image
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
      });

      const base64Image = Buffer.from(imageResponse.data).toString('base64');
      const mimeType = imageResponse.headers['content-type'] || 'image/jpeg';

      // Analyze with GPT-4 Vision
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a product identification expert. Analyze product images and extract:
- Product name
- Category
- Brand (if visible)
- Condition (new, used, etc.)
- Estimated price range
- Any visible text
- Key features visible in image

Return JSON with all extracted information.`,
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analyze this product image and extract all relevant information.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`,
                },
              },
            ],
          },
        ],
        max_tokens: 300,
      });

      const analysis = JSON.parse(completion.choices[0].message.content);
      const tokensUsed = completion.usage.total_tokens;

      return {
        ...analysis,
        tokensUsed,
        success: true,
      };
    } catch (error) {
      console.error('Image processing error:', error);
      return {
        success: false,
        error: error.message,
        tokensUsed: 0,
      };
    }
  }

  /**
   * Search products based on image analysis
   */
  async searchProductsByImage(imageUrl) {
    const analysis = await this.processImage(imageUrl);
    
    if (!analysis.success) {
      return { products: [], error: analysis.error };
    }

    // Use extracted information to search products
    const searchTerms = [
      analysis.product_name,
      analysis.category,
      analysis.brand,
    ].filter(Boolean).join(' ');

    // Import here to avoid circular dependency
    const ProductRecommender = (await import('./product-recommender.js')).default;
    const products = await ProductRecommender.searchProducts(searchTerms);

    return {
      products,
      analysis,
      searchTerms,
    };
  }
}

export default new ImageProcessor();
