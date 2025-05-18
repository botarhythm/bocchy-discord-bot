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
 * Strict Web Grounding型LLM要約ラッパー（2段階APIラウンドトリップ方式）
 * @param url 対象URL
 * @param character キャラクター設定（任意）
 * @returns LLM応答（JSON: { summary: string, grounding_ok: boolean }）
 */
export async function strictWebGroundedSummarize(url: string, character: string = ''): Promise<{ summary: string, grounding_ok: boolean }> {
  // --- step-1: crawl function calling（OpenAIにツール呼び出しを提案させる） ---
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
  if (!crawlCall || !crawlCall.function || !crawlCall.function.arguments) {
    return { summary: '情報取得不可', grounding_ok: false };
  }
  let crawlArgs: any = {};
  try {
    crawlArgs = JSON.parse(crawlCall.function.arguments);
  } catch {}
  const pageUrl = crawlArgs.url || url;
  const pageContent = await fetchPageContent(pageUrl);
  if (!pageContent || pageContent.length < 50) {
    return { summary: '情報取得不可', grounding_ok: false };
  }
  // --- step-2: crawlのtool outputをOpenAIに再リクエスト（summarize function calling） ---
  const toolOutputs = [{
    tool_call_id: crawlCall.id,
    output: { text: pageContent }
  }];
  const sumRes = await openai.chat.completions.create({
    model: 'gpt-4o-mini-2024-07-18',
    tools: [summarizeTool],
    response_format: { type: 'json_object' },
    messages: [
      { role: 'user', content: url },
      {
        role: 'tool',
        tool_call_id: crawlCall.id,
        content: JSON.stringify({ text: pageContent })
      },
      { role: 'system', content: 'Summarize ONLY from "page_content". If missing, return {"summary":"情報取得不可","grounding_ok":false}.' + (character ? ` キャラクター性: ${character}` : '') },
      { role: 'user', content: JSON.stringify({ page_content: pageContent, lang: 'ja', character }) }
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