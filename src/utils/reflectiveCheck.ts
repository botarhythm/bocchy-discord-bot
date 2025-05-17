import { openai, queuedOpenAI } from '../services/openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Bot応答の適切性を自己評価し、必要なら修正版を返す
 * @param {string} userPrompt - ユーザー発言
 * @param {string} botReply - 生成したBot応答
 * @returns {Promise<{ok: boolean, suggestion?: string}>}
 */
export async function reflectiveCheck(userPrompt: string, botReply: string): Promise<{ ok: boolean, suggestion?: string }> {
  const systemPrompt = `あなたはDiscord Botの自己監督AIです。以下のBot応答が「不適切・攻撃的・誤情報・ユーザーの感情を害する」場合は、修正版を日本語で提案してください。問題なければ「OK」とだけ返してください。`;
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `ユーザー: ${userPrompt}\nボット: ${botReply}` }
  ];
  const res = await queuedOpenAI(() => openai.chat.completions.create({
    model: 'gpt-4.1-nano-2025-04-14',
    messages,
  }));
  const content = res.choices[0]?.message?.content?.trim() || '';
  if (content === 'OK' || content === 'ok' || content.includes('問題ありません')) {
    return { ok: true };
  }
  return { ok: false, suggestion: content };
} 