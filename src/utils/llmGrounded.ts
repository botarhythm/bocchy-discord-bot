import crypto from 'crypto';
import { openai } from '../services/openai.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { fetchPageContent } from '../action-runner.js';

// --- crawlツール定義 ---
export const crawlTool = {
  type: 'function',
  function: {
    name: 'crawl',
    description: '指定URLのWebページ本文を抽出する',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'クロール対象のURL' },
        timestamp: { type: 'string', description: 'クロール時刻（ISO8601）' }
      },
      required: ['url', 'timestamp']
    }
  }
};

// --- summarizeツール定義 ---
export const summarizeTool = {
  type: 'function',
  function: {
    name: 'summarize',
    description: 'Webページ本文から要約を生成する',
    parameters: {
      type: 'object',
      properties: {
        page_content: { type: 'string', description: 'Webページ本文' },
        lang: { type: 'string', description: '要約言語（ja等）' },
        character: { type: 'string', description: '要約に反映するキャラクター設定（任意）' }
      },
      required: ['page_content', 'lang']
    }
  }
};

/**
 * Strict Web Grounding型LLM要約ラッパー（必ず先にWebクロール→本文のみLLMに渡す）
 * @param url 対象URL
 * @param character キャラクター設定（任意）
 * @returns LLM応答（string）
 */
export async function strictWebGroundedSummarize(url: string, character: string = ''): Promise<string> {
  // 1. まず必ずWebクロール
  const pageContent = await fetchPageContent(url);
  if (!pageContent || pageContent.length < 50) {
    return '情報取得不可';
  }
  // 2. 取得できた場合のみLLMに渡す
  const systemPrompt =
    '以下のテキストだけを根拠に要約してください。なければ「情報取得不可」と返してください。' +
    (character ? ` キャラクター性: ${character}` : '') +
    '\n---\n' + pageContent + '\n---';
  const userPrompt = 'この内容を日本語で要約してください。特徴やポイントを箇条書きで。事実のみ。';
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini-2024-07-18',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0
  });
  return res.choices[0]?.message?.content?.trim() || '情報取得不可';
} 