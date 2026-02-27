import openai from '../config/openai.js';
import fs from 'fs';
import axios from 'axios';

/**
 * Voice Processor for transcribing voice messages
 */
class VoiceProcessor {
  /**
   * Transcribe voice message to text
   */
  async transcribe(audioUrl, language = null) {
    try {
      // Download audio file
      const audioResponse = await axios.get(audioUrl, {
        responseType: 'stream',
      });

      // Save temporarily
      const tempPath = `/tmp/audio_${Date.now()}.ogg`;
      const writer = fs.createWriteStream(tempPath);
      audioResponse.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      // Transcribe with Whisper
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tempPath),
        model: 'whisper-1',
        language: language || undefined, // Auto-detect if not specified
        response_format: 'json',
      });

      // Clean up temp file
      fs.unlinkSync(tempPath);

      return {
        text: transcription.text,
        language: transcription.language,
        success: true,
      };
    } catch (error) {
      console.error('Voice transcription error:', error);
      return {
        text: '',
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Process voice message and return transcribed text
   */
  async processVoiceMessage(audioUrl, language = null) {
    return await this.transcribe(audioUrl, language);
  }
}

export default new VoiceProcessor();
