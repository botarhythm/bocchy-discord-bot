import crypto from 'crypto';
import { openai } from '../services/openai.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Strict Web Grounding型LLM要約ラッパー
 * @param webContent Webページ本文
 * @param userPrompt ユーザー指示（例:「この内容を日本語で要約してください。特徴やポイントを箇条書きで。事実のみ。」）
 * @returns LLM応答
 */
export async function llmGroundedSummarize(webContent: string, userPrompt: string): Promise<string> {
  if (!webContent || webContent.length < 50) return '情報取得不可';
  const hash = crypto.createHash('sha256').update(webContent).digest('hex');
  const systemPrompt = `You must answer *exclusively* from the provided web-content. If the answer is not present, reply "情報取得不可".\nPage hash: ${hash}\n<BEGIN_PAGE>\n${webContent}\n<END_PAGE>`;
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];
  // OpenAI function-calling API模倣（tool use/temperature:0/top_p:0.1固定）
  const res = await openai.chat.completions.create({
    model: 'gpt-4.1-nano-2025-04-14',
    messages,
    temperature: 0,
    top_p: 0.1
  });
  return res.choices?.[0]?.message?.content?.trim() || '情報取得不可';
} 