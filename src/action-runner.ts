import dotenv from "dotenv";
dotenv.config();
import fetch from 'node-fetch';
import { load } from 'cheerio';
import { OpenAI } from 'openai';
import yaml from 'js-yaml';
import fs from 'fs';
import { getSentiment } from './utils/sentimentAnalyzer.js';
import { analyzeGlobalContext } from './utils/analyzeGlobalContext.js';
import { reflectiveCheck } from './utils/reflectiveCheck.js';
import { logInterventionDecision } from './index.js';
import axios from 'axios';
import { updateUserProfileSummaryFromHistory } from './utils/userProfile.js';
import puppeteer from 'puppeteer';
import { openai, queuedOpenAI } from './services/openai.js';
import { supabase } from './services/supabase.js';
import { Message, Guild, Client, ChatInputCommandInteraction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { LRUCache } from 'lru-cache';
import { SubjectTracker, extractSubjectCandidates, createBranchNode, buildPrompt } from './utils/index.js';
import { CRAWL_MAX_DEPTH, CRAWL_MAX_LINKS_PER_PAGE, CRAWL_API_MAX_CALLS_PER_REQUEST, CRAWL_API_MAX_CALLS_PER_USER_PER_DAY, CRAWL_CACHE_TTL_MINUTES, BASE, MAX_ARTICLES } from './config/rules.js';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { strictWebGroundedSummarize } from './utils/llmGrounded.js';
import { ContextMemory } from './utils/contextMemory.js';

// --- クロールAPI利用回数管理 ---
const userCrawlCount = new Map(); // userId: { date: string, count: number }
const crawlCache = new LRUCache<string, any>({ max: 256, ttl: 1000 * 60 * (CRAWL_CACHE_TTL_MINUTES || 10) });

function getCrawlLimit(userId: string, isAdmin: boolean) {
  return {
    maxDepth: isAdmin ? CRAWL_MAX_DEPTH.admin : CRAWL_MAX_DEPTH.user,
    maxLinks: isAdmin ? CRAWL_MAX_LINKS_PER_PAGE.admin : CRAWL_MAX_LINKS_PER_PAGE.user,
    maxCalls: isAdmin ? CRAWL_API_MAX_CALLS_PER_REQUEST.admin : CRAWL_API_MAX_CALLS_PER_REQUEST.user,
    maxPerDay: isAdmin ? CRAWL_API_MAX_CALLS_PER_USER_PER_DAY.admin : CRAWL_API_MAX_CALLS_PER_USER_PER_DAY.user,
  };
}

function canCrawl(userId: string, isAdmin: boolean) {
  const today = new Date().toLocaleDateString('ja-JP');
  const rec = userCrawlCount.get(userId) || { date: today, count: 0 };
  if (rec.date !== today) {
    rec.date = today;
    rec.count = 0;
  }
  const { maxPerDay } = getCrawlLimit(userId, isAdmin);
  if (rec.count >= maxPerDay) return false;
  rec.count++;
  userCrawlCount.set(userId, rec);
  return true;
}

/**
 * 深掘りクロール（階層・リンク数・API回数・キャッシュ制限付き）
 */
export async function deepCrawl(url: string, userId: string, isAdmin: boolean, depth = 0, callCount = { v: 0 }, visited = new Set()): Promise<any[]> {
  const { maxDepth, maxLinks, maxCalls } = getCrawlLimit(userId, isAdmin);
  if (depth > maxDepth || callCount.v > maxCalls) return [];
  const cacheKey = `${url}|${depth}`;
  if (crawlCache.has(cacheKey)) return crawlCache.get(cacheKey);
  if (visited.has(url)) return [];
  visited.add(url);
  callCount.v++;
  let content = await fetchPageContent(url);
  let links: string[] = [];
  try {
    // cheerioでaタグ抽出
    const $ = load(content);
    links = $('a').map((_i, el) => $(el).attr('href')).get()
      .filter((href: string) => href && /^https?:\/\//.test(href))
      .slice(0, maxLinks);
  } catch {}
  const result = [{ url, content, links }];
  for (const link of links) {
    if (depth + 1 > maxDepth || callCount.v > maxCalls) break;
    const sub = await deepCrawl(link, userId, isAdmin, depth + 1, callCount, visited);
    result.push(...sub);
  }
  crawlCache.set(cacheKey, result);
  return result;
}

// --- 型定義 ---
export interface UserProfile {
  preferences?: Record<string, any>;
  profile_summary?: string;
  [key: string]: any;
}

export interface GlobalContext {
  tone?: string;
  topics?: string[];
  summary?: string;
  [key: string]: any;
}

export interface ConversationHistory {
  user?: string;
  bot?: string;
  [key: string]: any;
}

// Bocchyキャラクター設定をYAMLから読み込む
const bocchyConfig = yaml.load(fs.readFileSync('bocchy-character.yaml', 'utf8')) as any;

// --- URL抽出用: グローバルで1回だけ宣言 ---
const urlRegex = /(https?:\/\/[^\s]+)/g;

// --- LRUキャッシュ（summary/embedding用） ---
const summaryCache = new LRUCache<string, any>({ max: 256, ttl: 1000 * 60 * 10 }); // 10分
const embeddingCache = new LRUCache<string, any>({ max: 256, ttl: 1000 * 60 * 10 }); // 10分

// --- エンティティ抽出（URL＋人名＋イベント＋スポーツ種別） ---
function extractEntities(text: string): {
  urls: string[];
  persons: string[];
  events: string[];
  sports: string[];
} {
  const urls = text ? (text.match(urlRegex) || []) : [];
  // 人名抽出（簡易: 大谷翔平など漢字＋カタカナ/ひらがな/英字）
  const personRegex = /([\p{Script=Han}]{2,}(?:[\p{Script=Hiragana}\p{Script=Katakana}A-Za-z]{1,})?)/gu;
  const persons = text ? (text.match(personRegex) || []).filter(n => n.length > 1) : [];
  // イベント・試合名抽出（例: エンゼルス戦、ドジャース戦、W杯、決勝など）
  const eventRegex = /(\w+戦|\w+試合|W杯|決勝|オリンピック|シリーズ|大会|カップ|グランプリ)/g;
  const events = text ? (text.match(eventRegex) || []) : [];
  // スポーツ種別抽出（野球、サッカー、MLB、NPB、Jリーグ、バスケ等）
  const sportRegex = /(野球|サッカー|MLB|NPB|Jリーグ|バスケ|バレーボール|テニス|ゴルフ|ラグビー|卓球|eスポーツ)/g;
  const sports = text ? (text.match(sportRegex) || []) : [];
  return { urls, persons, events, sports };
}

// --- LLMによるエンティティ抽出 ---
async function extractEntitiesLLM(text: string): Promise<Record<string, any>> {
  if (!text || text.length < 2) return {};
  const prompt = `次のテキストから「人名」「組織名」「政策名」「イベント名」「話題」「URL」など重要なエンティティをJSON形式で抽出してください。\nテキスト: ${text}\n出力例: {"persons": ["大谷翔平"], "organizations": ["ムーディーズ"], "policies": ["財政赤字"], "events": ["米国債格下げ"], "topics": ["米国経済"], "urls": ["https://..."]}`;
  try {
    const res = await await queuedOpenAI(() => openai.chat.completions.create({
      model: 'gpt-4.1-nano-2025-04-14',
      messages: [
        { role: "system", content: "あなたはエンティティ抽出AIです。" },
        { role: "user", content: prompt }
      ],
      max_tokens: 256,
      temperature: 0.0
    }));
    const content = res.choices[0]?.message?.content?.trim() || "";
    const json = content.match(/\{[\s\S]*\}/)?.[0];
    if (json) return JSON.parse(json);
    return {};
  } catch (e) {
    console.warn("[extractEntitiesLLM] LLM抽出失敗", e);
    return {};
  }
}

// ユーザーの表示名・ニックネームを正しく取得
function getUserDisplayName(message: Message | ChatInputCommandInteraction): string {
  if ('guild' in message && 'member' in message && message.guild && message.member) {
    // サーバー内ならニックネーム→グローバル表示名→ユーザー名の順
    // @ts-ignore
    return message.member.displayName || message.member.user.globalName || message.member.user.username;
  }
  // DMまたはInteractionならグローバル表示名→ユーザー名
  // @ts-ignore
  return message.user?.globalName || message.user?.username || message.author?.globalName || message.author?.username;
}

// affinity
export async function getAffinity(userId: string, guildId: string): Promise<number> {
  return (await import('./utils/affinity.js')).getAffinity(userId, guildId);
}
export async function updateAffinity(userId: string, guildId: string, userMsg: string): Promise<void> {
  return (await import('./utils/affinity.js')).updateAffinity(userId, guildId, userMsg);
}

// buildCharacterPrompt
export function buildCharacterPrompt(
  message: Message | ChatInputCommandInteraction,
  affinity: number = 0,
  userProfile: UserProfile | null = null,
  globalContext: GlobalContext | null = null
): string {
  let prompt = '';
  if (bocchyConfig.mission) {
    prompt += `【ミッション】${bocchyConfig.mission}\n`;
  }
  if (bocchyConfig.values) {
    prompt += `【価値観】${(bocchyConfig.values as string[]).join(' / ')}\n`;
  }
  if (bocchyConfig.origin_story) {
    prompt += `【起源】${bocchyConfig.origin_story}\n`;
  }
  if (bocchyConfig.archetype) {
    prompt += `【アーキタイプ】${bocchyConfig.archetype}\n`;
  }
  if (bocchyConfig.mood?.default) {
    prompt += `【ムード】${bocchyConfig.mood.default}\n`;
  }
  if (bocchyConfig.output_preferences?.style) {
    prompt += `【出力スタイル】${bocchyConfig.output_preferences.style}\n`;
  }
  if (bocchyConfig.output_preferences?.emoji_usage) {
    prompt += `【絵文字使用】${bocchyConfig.output_preferences.emoji_usage}\n`;
  }
  const now = new Date();
  const jpTime = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  prompt += `【現在日時】${jpTime}（日本時間）\n`;
  const userDisplayName = getUserDisplayName(message);
  prompt += `【ユーザー情報】この会話の相手は「${userDisplayName}」さんです。応答文の適切な位置で「${userDisplayName}さん」と呼びかけ、親しみやすい文体で返答してください。\n`;
  if (bocchyConfig.first_person) {
    prompt += `【一人称】${bocchyConfig.first_person}\n`;
  }
  const relation =
    affinity > 0.6 ? 'とても親しい' :
    affinity < -0.4 ? '距離がある' : '普通';
  prompt += `【心理距離】${relation}\n`;
  return prompt;
}

// --- 無限ループ・自己応答防止ロジック ---
export const recentBotReplies = new LRUCache<string, boolean>({ max: 20, ttl: 1000 * 60 * 5 });
const botTemplates = [
  '指定されたURLのページ内容を要約します。',
  '検索でヒットした記事をご紹介します。',
  'ディープクロールの結果、情報が取得できませんでした。',
  'ページ内容が取得できませんでした。',
  '記事要約中にエラーが発生しました。',
  '検索結果が見つかりませんでした。',
];
const botUserName = 'ボッチー';
const botUserId = '9740'; // 実際はprocess.env.BOT_USER_ID等で取得推奨

// ---------- A.  summary を取ってシステムに渡すヘルパ ----------
export async function buildHistoryContext(
  supabase: SupabaseClient,
  userId: string,
  channelId: string,
  guildId: string | null = null,
  guild: Guild | null = null
): Promise<any[]> {
  if (!supabase) return [];
  // 1) 直近詳細 n＝SHORT_TURNS（チャンネル単位）
  const { data } = await supabase.from('conversation_histories').select('messages').eq('user_id', userId).eq('channel_id', channelId).maybeSingle() as any;
  const recent = (data?.messages ?? []).slice(-8);

  // 2) それ以前は「150 字要約」1 件だけ（チャンネル単位）
  const summaryKey = `summary:${userId}:${channelId}`;
  let sum = summaryCache.get(summaryKey);
  if (!sum) {
    const { data: sumData } = await supabase.from('conversation_summaries').select('summary').eq('user_id', userId).eq('channel_id', channelId).order('created_at', { ascending: false }).limit(1).maybeSingle() as any;
    sum = sumData;
    if (sum) summaryCache.set(summaryKey, sum);
  }

  // 3) サーバー全体の要約・履歴も取得
  let guildSummary = null;
  let guildRecent = [];
  let guildAllMessages = [];
  if (guildId) {
    const guildSummaryKey = `guildSummary:${guildId}`;
    let gsum = summaryCache.get(guildSummaryKey);
    if (!gsum) {
      const { data: gsumData } = await supabase.from('conversation_summaries').select('summary').eq('guild_id', guildId).order('created_at', { ascending: false }).limit(1).maybeSingle() as any;
      gsum = gsumData;
      if (gsum) summaryCache.set(guildSummaryKey, gsum);
    }
    guildSummary = gsum?.summary;

    const guildRecentKey = `guildRecent:${guildId}`;
    let ghist = summaryCache.get(guildRecentKey);
    if (!ghist) {
      const { data: ghistData } = await supabase.from('conversation_histories').select('messages').eq('guild_id', guildId).order('updated_at', { ascending: false }).limit(10).maybeSingle() as any;
      ghist = ghistData;
      if (ghist) summaryCache.set(guildRecentKey, ghist);
    }
    guildRecent = (ghist?.messages ?? []).slice(-2);
    guildAllMessages = (ghist?.messages ?? []);
  }

  // 4) ユーザープロファイル取得
  let userProfile = null;
  try {
    const userProfileKey = `profile:${userId}:${guildId}`;
    userProfile = summaryCache.get(userProfileKey);
    if (!userProfile) {
      const { data: profile } = await supabase.from('user_profiles').select('*').eq('user_id', userId).eq('guild_id', guildId).maybeSingle() as any;
      userProfile = profile;
      if (userProfile) summaryCache.set(userProfileKey, userProfile);
    }
  } catch (e) { userProfile = null; }

  // 5) ベクトル類似検索でパーソナライズ履歴取得（最大2件）
  let personalizedHistory: { user: string; bot: string }[] = [];
  try {
    const lastUserMsg = recent.length > 0 ? recent[recent.length-1].user : '';
    let embedding = null;
    const embeddingKey = `embedding:${userId}:${guildId}:${lastUserMsg}`;
    embedding = embeddingCache.get(embeddingKey);
    if (!embedding && lastUserMsg) {
      const embRes = await await queuedOpenAI(() => openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: lastUserMsg
      }));
      embedding = embRes.data[0].embedding;
      if (embedding) embeddingCache.set(embeddingKey, embedding);
    }
    if (embedding) {
      const { data: simRows } = await supabase.rpc('match_user_interactions', {
        p_user_id: userId,
        p_guild_id: guildId,
        p_embedding: embedding,
        p_match_threshold: 0.75,
        p_match_count: 2
      });
      personalizedHistory = (simRows || []).map((r: any) => ({ user: r.message, bot: r.bot_reply }));
    }
  } catch (e) { personalizedHistory = []; }

  // 6) グローバル文脈要約・感情トーン分析
  let globalContext = null;
  try {
    const allHistory = [...guildRecent, ...recent, ...personalizedHistory];
    globalContext = await analyzeGlobalContext(allHistory);
  } catch (e) { globalContext = null; }

  // 7) 参加者情報の取得（5名＋他n名の要約形式）
  let memberNames = [];
  let memberSummary = '';
  if (guild) {
    try {
      memberNames = await getGuildMemberNames(guild, 20);
      if (memberNames.length > 5) {
        memberSummary = `${memberNames.slice(0,5).join('、')}、他${memberNames.length-5}名`;
      } else {
        memberSummary = memberNames.join('、');
      }
    } catch (e) { memberSummary = ''; }
  }

  // 8) ユーザー相関関係サマリーの生成（要約のみ）
  let correlationSummary = '';
  try {
    const userPairCounts: Record<string, number> = {};
    const topicCounts: Record<string, number> = {};
    for (let i = 0; i < guildAllMessages.length - 1; i++) {
      const m1 = guildAllMessages[i];
      const m2 = guildAllMessages[i+1];
      if (m1.user && m2.user) {
        const pair = `${m1.user}↔${m2.user}`;
        userPairCounts[pair] = (userPairCounts[pair] || 0) + 1;
      }
      const words = (m1.user + ' ' + m1.bot).split(/\s+/);
      for (const w of words) {
        if (w.length > 1) topicCounts[w] = (topicCounts[w] || 0) + 1;
      }
    }
    const topPairs = Object.entries(userPairCounts)
      .sort((a: [string, number], b: [string, number]) => b[1]-a[1])
      .slice(0,2)
      .map(([pair, count]: [string, number]) => `・${pair}（${count}回）`)
      .join('\n');
    const topTopics = Object.entries(topicCounts)
      .sort((a: [string, number], b: [string, number]) => b[1]-a[1])
      .slice(0,2)
      .map(([topic, count]: [string, number]) => `#${topic}（${count}回）`)
      .join(' ');
    correlationSummary = `【サーバー内ユーザー相関サマリー】\n${topPairs}\n【共通話題】${topTopics}`;
  } catch (e) { correlationSummary = ''; }

  // --- プロンプト構築 ---
  const msgs = [];
  if (userProfile) {
    msgs.push({ role: 'system', content: `【ユーザープロファイル】${JSON.stringify(userProfile.preferences || {})}` });
  }
  if (globalContext) {
    if (globalContext.summary) {
      msgs.push({ role: 'system', content: `【会話全体要約】${globalContext.summary}` });
    }
    if (globalContext.topics && globalContext.topics.length > 0) {
      msgs.push({ role: 'system', content: `【主な話題】${globalContext.topics.slice(0,2).join('、')}` });
    }
    if (globalContext.tone) {
      msgs.push({ role: 'system', content: `【全体トーン】${globalContext.tone}` });
    }
  }
  if (guildSummary) msgs.push({ role: 'system', content: `【サーバー全体要約】${guildSummary}` });
  if (memberSummary) {
    msgs.push({ role: 'system', content: `【現在の参加者】${memberSummary}` });
  }
  if (correlationSummary) {
    msgs.push({ role: 'system', content: correlationSummary });
  }
  // --- 直近のユーザー→Botペアを必ずhistoryに含める ---
  const allHistory = [...guildRecent, ...personalizedHistory, ...recent];
  const latestPairs = allHistory.slice(-6);
  const topPriorityPairs = latestPairs.slice(-2);
  const highPriorityPairs = latestPairs.slice(-6, -2);

  // --- 本質的短期記憶: 直近の会話履歴から「会話の流れ要約」「未解決の問い」「ユーザーの期待」「感情トーン」をLLMで抽出し、systemメッセージとしてhistory冒頭に必ず追加 ---
  try {
    const conversationText = allHistory.map(h => `ユーザー: ${h.user || ''}\nボッチー: ${h.bot || ''}`).join('\n');
    const openai = new (await import('openai')).OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = `以下は直近の会話履歴です。このやりとり全体から「会話の流れ要約」「未解決の問い」「ユーザーの期待」「感情トーン」を日本語で簡潔に抽出し、JSONで出力してください。\n---\n${conversationText}\n---\n出力例: {\"topic\":\"...\",\"unresolved\":\"...\",\"expectation\":\"...\",\"tone\":\"...\"}`;
    const res = await await queuedOpenAI(() => openai.chat.completions.create({
      model: 'gpt-4.1-nano-2025-04-14',
      messages: [
        { role: 'system', content: 'あなたは会話要約AIです。' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 256,
      temperature: 0.2
    }));
    const content = res.choices[0]?.message?.content?.trim() || '';
    const json = content.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
      const obj = JSON.parse(json);
      if (obj.topic) msgs.unshift({ role: 'system', content: `【会話の流れ要約】${obj.topic}` });
      if (obj.unresolved) msgs.unshift({ role: 'system', content: `【未解決の問い】${obj.unresolved}` });
      if (obj.expectation) msgs.unshift({ role: 'system', content: `【ユーザーの期待】${obj.expectation}` });
      if (obj.tone) msgs.unshift({ role: 'system', content: `【感情トーン】${obj.tone}` });
    }
  } catch (e) {
    let msg = '[buildHistoryContext] 会話全体要約LLM失敗';
    if (typeof e === 'object' && e && 'message' in e) msg += `: ${(e as any).message}`;
    console.warn(msg, e);
  }
  // --- 追加: 直近の会話履歴から「現在の話題」「直前の課題」「技術的文脈」などをLLMで抽出し、systemメッセージとしてhistory冒頭に必ず追加 ---
  try {
    const conversationText = allHistory.map(h => `ユーザー: ${h.user || ''}\nボッチー: ${h.bot || ''}`).join('\n');
    const openai = new (await import('openai')).OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const metaPrompt = `以下の会話履歴から「現在の話題」「直前の課題」「技術的文脈や会話の一貫性」を日本語で簡潔に抽出し、JSONで出力してください。\n---\n${conversationText}\n---\n出力例: {\"currentTopic\":\"...\",\"currentIssue\":\"...\",\"contextMeta\":\"...\"}`;
    const res = await await queuedOpenAI(() => openai.chat.completions.create({
      model: 'gpt-4.1-nano-2025-04-14',
      messages: [
        { role: 'system', content: 'あなたは会話分脈抽出AIです。' },
        { role: 'user', content: metaPrompt }
      ],
      max_tokens: 256,
      temperature: 0.2
    }));
    const content = res.choices[0]?.message?.content?.trim() || '';
    const json = content.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
      const obj = JSON.parse(json);
      if (obj.currentTopic) msgs.unshift({ role: 'system', content: `【現在の話題】${obj.currentTopic}` });
      if (obj.currentIssue) msgs.unshift({ role: 'system', content: `【直前の課題】${obj.currentIssue}` });
      if (obj.contextMeta) msgs.unshift({ role: 'system', content: `【技術的文脈】${obj.contextMeta}` });
    }
  } catch (e) {
    let msg = '[buildHistoryContext] 分脈抽出LLM失敗';
    if (typeof e === 'object' && e && 'message' in e) msg += `: ${(e as any).message}`;
    console.warn(msg, e);
  }
  // --- 追加: 直近のユーザー発言から「多角的推論（考えられる複数の意図・期待・関心）」systemメッセージをLLMで生成し、history冒頭に必ず追加 ---
  try {
    const lastUserMsg = allHistory.length > 0 ? allHistory[allHistory.length-1].user : '';
    if (lastUserMsg && lastUserMsg.length > 2) {
      const openai = new (await import('openai')).OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const multiIntentPrompt = `次のユーザー発言から「考えられる複数の意図・期待・関心」を日本語で3つ程度、推論し、JSON配列で出力してください。\n---\n${lastUserMsg}\n---\n出力例: [\"人気の豆を知りたい\", \"産地や焙煎方法に興味がある\", \"おすすめを探している\"]`;
      const res = await await queuedOpenAI(() => openai.chat.completions.create({
        model: 'gpt-4.1-nano-2025-04-14',
        messages: [
          { role: 'system', content: 'あなたは多角的推論AIです。' },
          { role: 'user', content: multiIntentPrompt }
        ],
        max_tokens: 128,
        temperature: 0.3
      }));
      const content = res.choices[0]?.message?.content?.trim() || '';
      const arr = content.match(/\[.*\]/s)?.[0];
      if (arr) {
        const intents = JSON.parse(arr);
        if (Array.isArray(intents) && intents.length > 0) {
          msgs.unshift({ role: 'system', content: `【多角的推論】この発言から考えられる意図・期待・関心: ${intents.join(' / ')}` });
        }
      }
    }
  } catch (e) {
    let msg = '[buildHistoryContext] 多角的推論LLM失敗';
    if (typeof e === 'object' && e && 'message' in e) msg += `: ${(e as any).message}`;
    console.warn(msg, e);
  }
  // --- 長期記憶（要約・ベクトル検索）も同様にsystemメッセージ化して冒頭に追加 ---
  if (sum?.summary) {
    msgs.unshift({ role: 'system', content: `【長期記憶要約】${sum.summary}` });
  }
  // --- 圧縮時もこれらのsystemメッセージは絶対に消さない ---
  let totalLength = msgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  while (totalLength > 5000 && msgs.length > 8) {
    for (let i = 0; i < msgs.length; i++) {
      // 「会話の流れ要約」「未解決の問い」「ユーザーの期待」「感情トーン」「長期記憶要約」「ユーザーの意図推察」「現在の話題」「直前の課題」「技術的文脈」「多角的推論」systemメッセージは絶対に消さない
      if (/【(会話の流れ要約|未解決の問い|ユーザーの期待|感情トーン|長期記憶要約|ユーザーの意図推察|現在の話題|直前の課題|技術的文脈|多角的推論)】/.test(msgs[i].content)) continue;
      if (msgs[i].role !== 'system' && !(msgs[i] as any).entities?.urls?.length) {
        msgs.splice(i, 1);
        break;
      }
    }
    totalLength = msgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  }
  return msgs;
}

// --- ChatGPT風: Webページクロール＆自然言語要約 ---
export async function fetchPageContent(url: string): Promise<string> {
  console.debug('[fetchPageContent] 入力URL:', url);
  let content = '';
  let errorMsg = '';
  // 1. puppeteerで動的レンダリング＋readability
  try {
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const html = await page.content();
    await browser.close();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article && article.textContent && article.textContent.replace(/\s/g, '').length > 100) {
      console.debug('[fetchPageContent] puppeteer/readability成功:', article.textContent.slice(0, 200), '...length:', article.textContent.length);
      return article.textContent.trim();
    }
    // 補助: main/article/body/p/meta/og/h1/h2
    const $ = load(html);
    let text = [
      $('meta[property="og:description"]').attr('content') || '',
      $('meta[name="description"]').attr('content') || '',
      $('h1').first().text() || '',
      $('h2').first().text() || '',
      $('main').text() || '',
      $('article').text() || '',
      $('section').text() || '',
      $('body').text() || '',
      $('p').map((_i, el) => $(el).text()).get().join('\n')
    ].filter(Boolean).join('\n');
    if (text.replace(/\s/g, '').length > 100) {
      console.debug('[fetchPageContent] puppeteer/cheerio補助成功:', text.slice(0, 200), '...length:', text.length);
      return text.trim();
    }
  } catch (e) {
    errorMsg += '[puppeteer/readability失敗]';
    if (typeof e === 'object' && e && 'message' in e) errorMsg += `: ${(e as any).message}`;
    errorMsg += '\n';
    console.error('[fetchPageContent] puppeteer/readabilityエラー:', e);
  }
  // 2. fetch+cheerio+readabilityで静的HTML抽出
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article && article.textContent && article.textContent.replace(/\s/g, '').length > 100) {
      console.debug('[fetchPageContent] fetch/readability成功:', article.textContent.slice(0, 200), '...length:', article.textContent.length);
      return article.textContent.trim();
    }
    // 補助: main/article/body/p/meta/og/h1/h2
    const $ = load(html);
    let text = [
      $('meta[property="og:description"]').attr('content') || '',
      $('meta[name="description"]').attr('content') || '',
      $('h1').first().text() || '',
      $('h2').first().text() || '',
      $('main').text() || '',
      $('article').text() || '',
      $('section').text() || '',
      $('body').text() || '',
      $('p').map((_i, el) => $(el).text()).get().join('\n')
    ].filter(Boolean).join('\n');
    if (text.replace(/\s/g, '').length > 100) {
      console.debug('[fetchPageContent] fetch/cheerio補助成功:', text.slice(0, 200), '...length:', text.length);
      return text.trim();
    }
    errorMsg += '[cheerio/readabilityも短すぎ]';
    console.warn('[fetchPageContent] fetch/cheerio補助も短すぎ:', text.slice(0, 200), '...length:', text.length);
    return errorMsg || '';
  } catch (e) {
    errorMsg += '[fetch/cheerio失敗]';
    if (typeof e === 'object' && e && 'message' in e) errorMsg += `: ${(e as any).message}`;
    console.error('[fetchPageContent] fetch/cheerioエラー:', e);
    return errorMsg || '';
  } finally {
    clearTimeout(timeoutId);
  }
}

// --- ChatGPT風: Webページ内容をLLMで自然言語要約 ---
export async function summarizeWebPage(url: string): Promise<string> {
  console.debug('[summarizeWebPage] 入力URL:', url);
  if (!url || url.length < 8) {
    console.warn('[summarizeWebPage] URLが無効:', url);
    return 'ページ内容が取得できませんでした。URLが無効か、クロールが制限されている可能性があります。';
  }
  // Strict Web Grounding型で要約（新: 二段階パイプライン）
  const summary = await strictWebGroundedSummarize(url);
  console.debug('[summarizeWebPage] 要約結果:', summary);
  return summary;
}

// --- LLMによる検索クエリ生成 ---
async function getSearchQueryFromLLM(userPrompt: string): Promise<string> {
  const prompt = `あなたは検索エンジン用のクエリ生成AIです。ユーザーの質問や要望から、Google検索で最も適切な日本語キーワード列（例: '東京 ニュース 今日'）を1行で出力してください。余計な語句や敬語は除き、検索に最適な単語だけをスペース区切りで返してください。\n\nユーザーの質問: ${userPrompt}`;
  const res = await openai.chat.completions.create({
    model: 'gpt-4.1-nano-2025-04-14',
    messages: [{ role: "system", content: prompt }],
    max_tokens: 64,
    temperature: 0.0
  });
  return res.choices[0]?.message?.content?.trim() || '';
}

// ---- 新: ChatGPT風・自然なWeb検索体験 ----
export async function enhancedSearch(userPrompt: string, message: Message, affinity: number, supabase: SupabaseClient): Promise<{ answer: string, results: any[] }> {
  console.debug('[enhancedSearch] 入力:', { userPrompt, affinity });
  const useMarkdown = bocchyConfig.output_preferences?.format === 'markdown';
  // --- LLMで検索クエリを生成 ---
  const query = await getSearchQueryFromLLM(userPrompt);
  console.debug('[enhancedSearch] LLM生成クエリ:', query);
  if (!query) {
    return { answer: '検索クエリ生成に失敗しました。', results: [] };
  }
  let allResults = [];
  let seenLinks = new Set();
  let seenDomains = new Set();
  let results = await googleSearch(query);
  console.debug('[enhancedSearch] googleSearch結果:', results);
  if (results && results.length > 0) {
    for (const r of results) {
      const domain = r.link.match(/^https?:\/\/(.*?)(\/|$)/)?.[1] || '';
      if (!seenLinks.has(r.link) && !seenDomains.has(domain)) {
        allResults.push(r);
        seenLinks.add(r.link);
        seenDomains.add(domain);
      }
      if (allResults.length >= MAX_ARTICLES) break;
    }
  }
  // --- 検索結果0件 ---
  if (allResults.length === 0) {
    console.debug('[enhancedSearch] allResultsが空: 検索結果0件');
    return { answer: '検索結果が見つかりませんでした。キーワードや表記を変えて再度お試しください。', results: [] };
  }
  // --- 検索結果1件以上 ---
  const topResults = allResults.slice(0, 3);
  // --- 主要キーワード抽出（簡易: ユーザー質問の名詞・英単語を抽出） ---
  function extractMainKeywords(text: string): string[] {
    const words = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-zA-Z0-9_\-]{2,}/gu) || [];
    return words.filter(w => w.length > 1);
  }
  const mainKeywords = extractMainKeywords(userPrompt);
  console.debug('[enhancedSearch] mainKeywords:', mainKeywords);
  // --- 検索結果が主題に合うか判定（2つ以上の主要キーワードが含まれる場合のみ） ---
  const relevantResults = topResults.filter(r => {
    const hitCount = mainKeywords.filter(kw => r.title.includes(kw) || r.snippet.includes(kw)).length;
    console.debug(`[enhancedSearch] resultタイトル: ${r.title}, スニペット: ${r.snippet}, hitCount: ${hitCount}`);
    return hitCount >= 2;
  });
  console.debug('[enhancedSearch] relevantResults:', relevantResults);
  // --- 公式・信頼できるドメインのみ優先 ---
  function isTrustedDomain(link: string): boolean {
    return /google\\.com|cloud\\.google\\.com|developers\\.google\\.com|ai\\.google\\.com|wikipedia\\.org|docs\\.google\\.com/.test(link);
  }
  const trustedResults = relevantResults.filter(r => isTrustedDomain(r.link));
  console.debug('[enhancedSearch] trustedResults:', trustedResults);
  // --- 知識ベース回答（暫定: Google AI/クラウド系の例） ---
  function getKnowledgeBaseAnswer(userPrompt: string): string {
    return `ご質問の内容について、公式・信頼できる情報源から有益な検索結果が見つかりませんでした。\n\nGoogleのAIやクラウド関連サービスの全体像は、\n- Google Cloud Platform（GCP）: インフラ全般\n- Vertex AI: AI開発・運用\n- Google AI: AI技術・API\n- Google Developer Console: 管理画面\n- Google Workspace: 業務ツール\n\nのように整理できます。\n\nもし特に知りたいサービスや使い方があれば、追加でご質問ください。`;
  }
  if (trustedResults.length === 0) {
    return { answer: getKnowledgeBaseAnswer(userPrompt), results: [] };
  }
  const finalResults = trustedResults;
  let intro = `検索でヒットした記事をご紹介します。\n`;
  finalResults.forEach((r, idx) => {
    intro += `\n${idx+1}. タイトル: ${r.title}\nスニペット: ${r.snippet}\nURL: ${r.link}\n`;
  });
  if (useMarkdown) intro += '\n\n【出力形式】Markdownで見やすくまとめてください。';
  let prompt = `${intro}\n\nこれらの記事の内容を簡単に要約し、どんな情報が得られるかを説明してください。`;
  let llmAnswer = '';
  try {
    llmAnswer = await llmRespond(userPrompt, prompt, message, [], buildCharacterPrompt(message, affinity));
  } catch (e) {
    llmAnswer = '記事要約中にエラーが発生しました。記事リストのみご参照ください。';
  }
  return { answer: intro + '\n' + llmAnswer, results: finalResults };
}

// --- saveHistory: 履歴保存の簡易実装 ---
export async function saveHistory(supabase: SupabaseClient, message: Message, userMsg: string, botMsg: string, affinity: number): Promise<void> {
  if (!supabase) return;
  try {
    const userId = message.author.id;
    const channelId = message.channel?.id;
    const guildId = message.guild?.id || '';
    await supabase.from('conversation_histories').upsert([
      {
        user_id: userId,
        channel_id: channelId,
        guild_id: guildId,
        messages: [{ user: userMsg, bot: botMsg, affinity, timestamp: new Date().toISOString() }],
        updated_at: new Date().toISOString()
      }
    ], { onConflict: ['user_id', 'channel_id', 'guild_id'].join(',') });
  } catch (e) {
    console.warn('[saveHistory] 履歴保存エラー:', e);
  }
}

// --- runPipeline本実装 ---
export async function runPipeline(action: string, { message, flags, supabase, botSilenceUntil }: { message: Message, flags: any, supabase: SupabaseClient, botSilenceUntil?: number }): Promise<void> {
  // --- 応答停止中は即return ---
  const globalBotSilenceUntil = (typeof global !== 'undefined' && (global as any).botSilenceUntil) ? (global as any).botSilenceUntil : undefined;
  const localBotSilenceUntil = typeof botSilenceUntil !== 'undefined' ? botSilenceUntil : undefined;
  if ((typeof localBotSilenceUntil !== 'undefined' && Date.now() < localBotSilenceUntil) || (typeof globalBotSilenceUntil !== 'undefined' && Date.now() < globalBotSilenceUntil)) {
    console.log('[応答停止中] runPipeline抑止');
    return;
  }
  try {
    const userId = message.author.id;
    const channelId = message.channel?.id;
    const guildId = message.guild?.id || '';
    // 親密度取得
    const affinity = supabase ? await getAffinity(userId, guildId) : 0;
    // --- 主語トラッキング ---
    const subjectTracker = new SubjectTracker();
    // 1. NLPで主語候補抽出
    const nlpCandidates = extractSubjectCandidates(message.content);
    // 2. 履歴やNLP候補から主語を推定
    const subject = subjectTracker.guessSubject(nlpCandidates) || SubjectTracker.getDefaultSubject();
    // 3. 分岐ツリー型ノード生成（仮説は未実装、メイン分岐のみ）
    const branch = createBranchNode({
      id: `${userId}-${Date.now()}`,
      parentId: null,
      subject,
      messages: [message.content],
    });
    // 4. 主語明示型プロンプト生成
    let prompt = buildPrompt(branch);
    let systemPrompt = '';
    let userPrompt = message.content;
    let history: any[] = [];
    let systemCharPrompt = '';
    // --- 短期記憶バッファにユーザー発話を記録 ---
    const memory = new ContextMemory(BASE.SHORT_TERM_MEMORY_LENGTH || 8);
    memory.addMessage('user', message.content);

    // --- テスト仕様同期コメント ---
    // テスト（test/handlers/action-runner.test.ts）では「コメントにURLが含まれる場合は必ずfetchPageContentが呼ばれ、LLM応答が返る」ことを期待している。
    // そのため、実装でも必ずURL検出時はfetchPageContent＋LLM要約を実行すること。

    // --- クエリ主導型: 検索・クロール命令が含まれる場合は必ず検索・クロールを実行 ---
    // 検索発動判定はindex.tsで行うため、ここは削除

    // --- URLが含まれる場合は必ずfetchPageContent＋LLM要約を実行 ---
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = message.content.match(urlRegex) || [];
    // 直近の応答で出力したURLを記憶するためのセット
    const recentlyOutputUrls = new Set<string>();
    // 直近応答で出力したURLは除外
    const filteredUrls = urls.filter(url => !recentlyOutputUrls.has(url));
    if (filteredUrls.length > 0) {
      const url = filteredUrls[0];
      let pageContent = '';
      let errorMsg = '';
      let title = '';
      try {
        const fetched = await fetchPageContent(url);
        pageContent = typeof fetched === 'string' ? fetched : '';
        title = pageContent ? pageContent.split('\n')[0].slice(0, 60) : '';
      } catch (e) {
        errorMsg = '[fetchPageContentエラー] ' + (e && typeof e === 'object' && 'message' in e ? (e as any).message : String(e));
      }
      if (pageContent && pageContent.length > 50) {
        let intro = `指定されたURLのページ内容を要約します。\n\nタイトル: ${title}\n抜粋: ${pageContent.slice(0, 200)}\nURL: ${url}\n`;
        let prompt = `${intro}\n\nこのページの内容を簡単に要約し、どんな特徴や情報が得られるかを説明してください。`;
        const llmAnswer = await llmRespond(message.content, prompt, message, [], buildCharacterPrompt(message, affinity));
        memory.addMessage('assistant', intro + '\n' + llmAnswer);
        await message.reply(intro + '\n' + llmAnswer);
        recentlyOutputUrls.add(url); // 出力したURLを記憶
        if (supabase) await updateAffinity(userId, guildId, message.content);
        if (supabase) await saveHistory(supabase, message, message.content, intro + '\n' + llmAnswer, affinity);
        return;
      } else {
        await message.reply(errorMsg || 'ページ内容が取得できませんでした。URLが無効か、クロールが制限されている可能性があります。');
        return;
      }
    }

    // --- URL要約強制モード ---
    if (flags && flags.forceUrlSummaryMode && flags.recentUrlSummary && flags.url) {
      systemPrompt = `【重要】以下のURL内容を必ず参照し、事実に基づいて答えてください。創作や推測は禁止です。\n----\n${flags.recentUrlSummary}\n----\n`;
      userPrompt = `このURL（${flags.url}）の内容を要約し、特徴を事実ベースで説明してください。創作や推測は禁止です。`;
      history = [];
      systemCharPrompt = '';
      prompt = '';
    } else {
      // --- 短期記憶バッファから履歴を取得し、'bot'→'assistant'に変換 ---
      history = memory.getRecentHistory().map((h: any) => h.role === 'bot' ? { ...h, role: 'assistant' } : h);
    }
    // 5. LLM応答生成
    const answer = await llmRespond(userPrompt, systemCharPrompt + systemPrompt + prompt, message, history);
    // --- ボット応答を短期記憶バッファに記録（role: 'assistant'） ---
    memory.addMessage('assistant', answer);
    await message.reply(answer);
    if (supabase) await updateAffinity(userId, guildId, message.content);
    if (supabase) await saveHistory(supabase, message, message.content, answer, affinity);
    // --- recentBotRepliesに実際の応答内容で記録 ---
    recentBotReplies.set(answer, true);
  } catch (err) {
    console.error('[runPipelineエラー]', err);
    await message.reply('エラーが発生しました。管理者にご連絡ください。');
  }
}

export async function shouldContextuallyIntervene(history: any[], globalContext: GlobalContext | null = null): Promise<{ intervene: boolean, reason: string }> {
  // history: [{role, content, ...}] の配列（直近10件程度）
  // globalContext: {topics, tone, summary} など
  const formatted = history.slice(-10).map(h => `${h.role}: ${h.content}`).join('\n');
  let contextStr = '';
  if (globalContext) {
    if (globalContext.topics?.length) contextStr += `主な話題: ${globalContext.topics.join('、')}\n`;
    if (globalContext.tone) contextStr += `感情トーン: ${globalContext.tone}\n`;
    if (globalContext.summary) contextStr += `要約: ${globalContext.summary}\n`;
  }
  const prompt = `以下はDiscordの会話履歴です。今このタイミングでAIが自然に介入（発言）すべきか判定してください。\n---\n${contextStr}\n${formatted}\n---\n【質問】今AIが介入すべきですか？（はい/いいえで答え、理由も簡潔に日本語で述べてください）`;
  try {
    const openai = new (await import('openai')).OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await await queuedOpenAI(() => openai.chat.completions.create({
      model: 'gpt-4.1-nano-2025-04-14',
      messages: [
        { role: 'system', content: 'あなたは会話介入判定AIです。' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 64,
      temperature: 0.0
    }));
    const content = res.choices[0]?.message?.content?.trim() || '';
    const intervene = /^はい/.test(content);
    return { intervene, reason: content };
  } catch (e) {
    console.warn('[shouldContextuallyIntervene] LLM判定失敗', e);
    return { intervene: false, reason: 'LLM判定失敗' };
  }
}

async function getGuildMemberNames(guild: Guild, limit: number): Promise<string[]> {
  // TODO: 本実装ではguild.members.fetch()等で取得
  return [];
}

// deepCrawlの結果をユーザーに返すための新しい関数
export async function replyDeepCrawlSummary(url: string, userPrompt: string, message: Message, affinity: number) {
  try {
    const userId = message.author.id;
    const isAdmin = false; // 必要に応じて判定
    const results = await deepCrawl(url, userId, isAdmin);
    if (!results || results.length === 0) {
      await message.reply('ディープクロールの結果、情報が取得できませんでした。URLやリンク先が無効か、クロールが制限されている可能性があります。');
      return;
    }
    // 各ページのタイトル・抜粋・URLをリスト化
    const topResults = results.slice(0, 3);
    let intro = `指定されたURLとそのリンク先をクロールし、以下の情報が得られました。\n`;
    topResults.forEach((r, idx) => {
      const title = r.content ? r.content.split('\n')[0].slice(0, 60) : '';
      const excerpt = r.content ? r.content.slice(0, 200) : '';
      intro += `\n${idx+1}. タイトル: ${title}\n抜粋: ${excerpt}\nURL: ${r.url}\n`;
    });
    let prompt = `${intro}\n\nこれらのページから分かること・共通点・特徴を要約してください。`;
    const llmAnswer = await llmRespond(userPrompt, prompt, message, [], buildCharacterPrompt(message, affinity));
    await message.reply(intro + '\n' + llmAnswer);
  } catch (e) {
    await message.reply('ディープクロール中にエラーが発生しました。管理者にご連絡ください。');
  }
}

// --- Google検索API呼び出し ---
export async function googleSearch(query: string, attempt: number = 0): Promise<any[]> {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;
  console.debug('[googleSearch] 入力クエリ:', query, 'API_KEY:', apiKey ? 'set' : 'unset', 'CSE_ID:', cseId ? 'set' : 'unset');
  if (!apiKey || !cseId) {
    console.warn('[googleSearch] Google APIキーまたはCSE IDが未設定です。空配列を返します');
    return [];
  }
  if (!query) {
    console.warn('[googleSearch] 検索クエリが空です。空配列を返します');
    return [];
  }
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}` +
              `&q=${encodeURIComponent(query)}&hl=ja&gl=jp&lr=lang_ja&sort=date`;
  console.debug('[googleSearch] APIリクエストURL:', url);
  try {
    const res = await fetch(url);
    console.debug('[googleSearch] APIレスポンスstatus:', res.status);
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[googleSearch] Google APIエラー: status=${res.status} body=${errText}。空配列を返します`);
      return [];
    }
    const data = await res.json() as any;
    console.debug('[googleSearch] APIレスポンス全体:', JSON.stringify(data));
    if (!data.items || data.items.length === 0) {
      if (data.error) {
        console.warn(`[googleSearch] Google APIレスポンスエラー:`, data.error, '空配列を返します');
      } else {
        console.warn('[googleSearch] Google APIレスポンスにitemsが存在しないか空です。空配列を返します');
      }
      return [];
    }
    return data.items.map((i: any) => ({ title: i.title, link: i.link, snippet: i.snippet }));
  } catch (e) {
    console.warn('[googleSearch] fetch例外:', e, '空配列を返します');
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      return await googleSearch(query, attempt + 1);
    }
    return [];
  }
}

// --- LLM応答生成 ---
export async function llmRespond(prompt: string, systemPrompt: string = "", message: Message | null = null, history: any[] = [], charPrompt: string | null = null, temperature: number = 0.7): Promise<string> {
  const systemCharPrompt = charPrompt ?? (message ? buildCharacterPrompt(message) : "");
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemCharPrompt + (systemPrompt ? `\n${systemPrompt}` : "") },
    ...history
  ];
  messages.push({ role: "user", content: prompt });
  const completion = await await queuedOpenAI(() => openai.chat.completions.create({
    model: 'gpt-4.1-nano-2025-04-14',
    messages,
    temperature
  }));
  return completion.choices[0]?.message?.content || "ごめんなさい、うまく答えられませんでした。";
}
