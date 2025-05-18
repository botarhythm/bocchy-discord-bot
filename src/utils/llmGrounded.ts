import crypto from 'crypto';
import { openai } from '../services/openai.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

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
        lang: { type: 'string', description: '要約言語（ja等）' }
      },
      required: ['page_content', 'lang']
    }
  }
};

/**
 * Strict Web Grounding型LLM要約ラッパー（二段階: crawl→summarize）
 * @param url 対象URL
 * @returns LLM応答（JSON: { summary: string, grounding_ok: boolean }）
 */
export async function strictWebGroundedSummarize(url: string): Promise<{ summary: string, grounding_ok: boolean }> {
  // --- step-1: crawl（function calling強制） ---
  const crawlRes = await openai.chat.completions.create({
    model: 'gpt-4o-mini-2024-07-18',
    tools: [crawlTool],
    tool_choice: { type: 'function', function: { name: 'crawl' } },
    messages: [
      { role: 'user', content: url }
    ],
    temperature: 0
  });
  const crawlCall = crawlRes.choices?.[0]?.message?.tool_calls?.[0];
  const page = crawlCall?.args?.text || '';
  if (!page || page.length < 50) {
    return { summary: '情報取得不可', grounding_ok: false };
  }
  // --- step-2: summarize（JSON mode＋function calling強制） ---
  const sumRes = await openai.chat.completions.create({
    model: 'gpt-4o-mini-2024-07-18',
    response_format: { type: 'json_object' },
    tools: [summarizeTool],
    tool_choice: { type: 'function', function: { name: 'summarize' } },
    messages: [
      { role: 'system', content: 'Summarize ONLY from "page_content". If missing, return {"summary":"情報取得不可","grounding_ok":false}.' },
      { role: 'user', content: JSON.stringify({ page_content: page, lang: 'ja' }) }
    ],
    temperature: 0
  });
  let summary = '情報取得不可';
  let grounding_ok = false;
  try {
    const json = JSON.parse(sumRes.choices?.[0]?.message?.content || '{}');
    summary = json.summary || '情報取得不可';
    grounding_ok = !!json.grounding_ok;
  } catch {}
  return { summary, grounding_ok };
} 