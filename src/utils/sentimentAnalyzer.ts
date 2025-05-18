import dotenv from 'dotenv';
import { openai } from '../services/openai.js';
dotenv.config();

/**
 * テキストの感情を「positive」「negative」「neutral」のいずれかで判定し、1語で返します。
 */
export async function getSentiment(text: string): Promise<'positive' | 'neutral' | 'negative'> {
  // OpenAI APIによる感情分析
  const systemPrompt = '以下のテキストの感情を「positive」「negative」「neutral」のいずれかで判定し、1語で返してください。';
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4.1-nano-2025-04-14',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ]
    });
    const label = res.choices[0]?.message?.content?.trim().toLowerCase() || 'neutral';
    if (label === 'positive' || label === 'neutral' || label === 'negative') {
      return label;
    }
    return 'neutral';
  } catch (error) {
    console.error('[sentimentAnalyzer] 感情判定エラー:', error);
    return 'neutral';
  }
}