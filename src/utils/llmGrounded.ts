import crypto from 'crypto';
import { openai } from '../services/openai.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { fetchPageContent } from '../action-runner.js';
import { encoding_for_model } from '@dqbd/tiktoken';
import fs from 'fs';
import yaml from 'js-yaml';

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

// 本文を最大4000トークン以内にトリミング（tiktoken使用）
async function trimContentForPromptByToken(content: string, systemPrompt: string, userPromptPrefix: string, maxTotalTokens = 8000) {
  // 空白・改行・HTMLタグ・重複行を除去
  content = content.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/([\r\n])\1+/g, '$1').trim();
  const enc = encoding_for_model('gpt-4.1-nano-2025-04-14');
  // まずプロンプト部分のトークン数を計算
  const promptTokens = enc.encode(systemPrompt).length + enc.encode(userPromptPrefix).length;
  // 本文を1文字ずつ追加し、maxTotalTokensを超えない範囲で切り詰め
  let allowedTokens = maxTotalTokens - promptTokens - 100; // 余裕を持たせる
  let tokens = 0, i = 0;
  let result = '';
  while (i < content.length && tokens < allowedTokens) {
    const char = content[i];
    const charTokens = enc.encode(char).length;
    if (tokens + charTokens > allowedTokens) break;
    result += char;
    tokens += charTokens;
    i++;
  }
  enc.free();
  return result;
}

/**
 * Strict Web Grounding型LLM要約ラッパー（必ず先にWebクロール→本文のみLLMに渡す）
 * @param url 対象URL
 * @param character キャラクター設定（任意）
 * @param question ユーザー質問（任意）
 * @returns LLM応答（string）
 */
export async function strictWebGroundedSummarize(url: string, character: string = '', question: string = ''): Promise<string> {
  console.log('[Grounding] 要約対象URL:', url);
  // 1. まず必ずWebクロール
  let pageContent: string | null = null;
  try {
    pageContent = await fetchPageContent(url);
    console.log('[Grounding] fetchPageContent結果:', pageContent?.slice(0, 200), '...length:', pageContent?.length);
  } catch (e) {
    console.error('[Grounding] fetchPageContentエラー:', e);
    return '情報取得不可（クロールエラー）';
  }
  if (!pageContent || pageContent.length < 50) {
    console.warn('[Grounding] ページ内容が取得できませんでした。');
    return '情報取得不可';
  }
  // --- キャラクター定義をsystem promptの先頭に合成 ---
  let bocchyCharYaml = '';
  try {
    bocchyCharYaml = fs.readFileSync('bocchy-character.yaml', 'utf8');
  } catch (e) {
    console.warn('[Grounding] bocchy-character.yaml読み込み失敗:', e);
    bocchyCharYaml = '';
  }
  const systemPrompt = `【キャラクター定義】\n${bocchyCharYaml}\n---`;
  let userPromptPrefix = '';
  userPromptPrefix += '以下の内容をもとに、350～420字程度まで、口コミやサービスの流れ、利用シーンも交えて、やさしく・親しみやすい文章でまとめてください。※自分の体験談や創作エピソードは加えず、取得した情報のみを要約し、LLMの知識で役立つ補足や背景解説も自然に加えてください。箇条書きや要点3つなどにはせず、1～2文ごとに自然な改行（段落分け）を入れて、読みやすくしてください。「当サイト」「私たち」などサイト運営者のような表現は避けてください。ボッチーとしての主観的な感想や意見、コメント（例：「ボッチー的には～」「こういう点が面白いと思います」など）は歓迎です。客観的な要約＋ボッチーの視点でのコメントが混ざるようにしてください。\n---\n';
  const trimmedContent = await trimContentForPromptByToken(pageContent, systemPrompt, userPromptPrefix);
  const userPrompt = userPromptPrefix + trimmedContent + '\n---';
  console.log('[Grounding] LLM system prompt:', systemPrompt.slice(0, 500));
  console.log('[Grounding] LLM user prompt:', userPrompt);
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4.1-nano-2025-04-14',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      max_tokens: 700
    });
    const answer = res.choices?.[0]?.message?.content?.trim() || '';
    console.log('[Grounding] LLM応答:', answer);
    return answer;
  } catch (e) {
    console.error('[Grounding] LLM APIエラー:', e);
    return '情報取得不可（LLMエラー）';
  }
} 