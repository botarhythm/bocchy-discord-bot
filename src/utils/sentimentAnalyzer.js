import dotenv from 'dotenv';
import { OpenAI } from 'openai';
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * テキストの感情を「positive」「negative」「neutral」のいずれかで判定し、1語で返します。
 */
export async function getSentiment(text) {
  // OpenAI APIによる感情分析
  const systemPrompt = '以下のテキストの感情を「positive」「negative」「neutral」のいずれかで判定し、1語で返してください。';
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini-2024-07-18',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ]
    });
    const label = res.choices[0]?.message?.content?.trim().toLowerCase() || 'neutral';
    return ['positive', 'negative', 'neutral'].includes(label) ? label : 'neutral';
  } catch (error) {
    console.error('[sentimentAnalyzer] 感情判定エラー:', error);
    return 'neutral';
  }
}