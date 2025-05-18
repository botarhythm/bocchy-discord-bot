import dotenv from "dotenv";
dotenv.config();
import fetch from 'node-fetch';
import { load } from 'cheerio';
import { OpenAI } from 'openai';
import yaml from 'js-yaml';
import fs from 'fs';
import { getAffinity, updateAffinity } from './utils/affinity.js';
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

function buildCharacterPrompt(
  message: Message | ChatInputCommandInteraction,
  affinity: number = 0,
  userProfile: UserProfile | null = null,
  globalContext: GlobalContext | null = null
): string {
  let prompt = '';
  // v2.0仕様に基づくプロンプト構築
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
  // 現在日時（日本時間）
  const now = new Date();
  const jpTime = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  prompt += `【現在日時】${jpTime}（日本時間）\n`;
  // ユーザー呼称
  const userDisplayName = getUserDisplayName(message);
  prompt += `【ユーザー情報】この会話の相手は「${userDisplayName}」さんです。応答文の適切な位置で「${userDisplayName}さん」と呼びかけ、親しみやすい文体で返答してください。\n`;
  // 一人称
  if (bocchyConfig.first_person) {
    prompt += `【一人称】${bocchyConfig.first_person}\n`;
  }
  // 親密度による心理距離
  const relation =
    affinity > 0.6 ? 'とても親しい' :
    affinity < -0.4 ? '距離がある' : '普通';
  prompt += `【心理距離】${relation}\n`;
  // ユーザープロファイル・好み・傾向
  if (userProfile && userProfile.preferences) {
    prompt += `【ユーザーの好み・傾向】${JSON.stringify(userProfile.preferences)}\n`;
  }
  if (userProfile && userProfile.profile_summary) {
    prompt += `【会話傾向・要望】${userProfile.profile_summary}\n`;
  }
  // 会話全体の感情トーン・主な話題
  if (globalContext) {
    if (globalContext.tone) {
      prompt += `【会話全体の感情トーン】${globalContext.tone}\n`;
    }
    if (globalContext.topics && globalContext.topics.length > 0) {
      prompt += `【最近よく話題にしているテーマ】${globalContext.topics.join('、')}\n`;
    }
  }
  return prompt;
}

// ---------- 0. 定数 ----------
const SHORT_TURNS   = 8;   // ← 直近 8 往復だけ詳細（元は4）

// --- 短期記憶バッファ（ContextMemory） ---
const memory = new ContextMemory(BASE.SHORT_TERM_MEMORY_LENGTH || 8);
// runPipeline等でmemory.addMessage('user'|'bot', content)を呼び、プロンプト生成時にmemory.getRecentHistory()を利用

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

// ---- 1. googleSearch: 信頼性の高いサイトを優先しつつSNS/ブログも含める（堅牢化・リトライ・エラー詳細） ----
async function googleSearch(query: string, attempt: number = 0): Promise<any[]> {
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
  try {
    const res = await fetch(url);
    console.debug('[googleSearch] APIリクエストURL:', url, 'status:', res.status);
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[googleSearch] Google APIエラー: status=${res.status} body=${errText}。空配列を返します`);
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
        return await googleSearch(query, attempt + 1);
      }
      return [];
    }
    const data = await res.json() as any;
    console.debug('[googleSearch] APIレスポンス:', JSON.stringify(data).slice(0, 500));
    if (!data.items || data.items.length === 0) {
      if (data.error) {
        console.warn(`[googleSearch] Google APIレスポンスエラー:`, data.error, '空配列を返します');
      } else {
        console.warn('[googleSearch] Google APIレスポンスにitemsが存在しないか空です。空配列を返します');
      }
      return [];
    }
    // 除外ドメインリスト（ログイン必須・リダイレクト・広告系のみ厳格除外）
    const EXCLUDE_DOMAINS = [
      'login', 'auth', 'accounts.google.com', 'ad.', 'ads.', 'doubleclick.net', 'googlesyndication.com'
    ];
    // 優先ドメインリスト（公式・教育・ニュース・自治体）
    const PRIORITY_DOMAINS = [
      'go.jp', 'ac.jp', 'ed.jp', 'nhk.or.jp', 'asahi.com', 'yomiuri.co.jp', 'mainichi.jp',
      'nikkei.com', 'reuters.com', 'bloomberg.co.jp', 'news.yahoo.co.jp', 'city.', 'pref.', 'gkz.or.jp', 'or.jp', 'co.jp', 'jp', 'com', 'org', 'net'
    ];
    // SNS/ブログも候補に含める
    const filtered = data.items
      .filter((i: any) => /^https?:\/\//.test(i.link))
      .filter((i: any) => !EXCLUDE_DOMAINS.some(domain => i.link.includes(domain)))
      .sort((a: any, b: any) => {
        const aPriority = PRIORITY_DOMAINS.some(domain => a.link.includes(domain)) ? 2 :
                          /twitter|x\.com|facebook|instagram|threads|note|blog|tiktok|line|pinterest|linkedin|youtube|discord/.test(a.link) ? 1 : 0;
        const bPriority = PRIORITY_DOMAINS.some(domain => b.link.includes(domain)) ? 2 :
                          /twitter|x\.com|facebook|instagram|threads|note|blog|tiktok|line|pinterest|linkedin|youtube|discord/.test(b.link) ? 1 : 0;
        return bPriority - aPriority;
      })
      .slice(0, MAX_ARTICLES)
      .map((i: any) => ({ title: i.title, link: i.link, snippet: i.snippet }));
    return filtered;
  } catch (e) {
    console.warn('[googleSearch] fetch例外:', e, '空配列を返します');
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      return await googleSearch(query, attempt + 1);
    }
    return [];
  }
}

// --- llmRespond: temperature引数追加 ---
async function llmRespond(prompt: string, systemPrompt: string = "", message: Message | null = null, history: any[] = [], charPrompt: string | null = null, temperature: number = 0.7): Promise<string> {
  const systemCharPrompt = charPrompt ?? (message ? buildCharacterPrompt(message) : "");
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemCharPrompt + (systemPrompt ? `\n${systemPrompt}` : "") },
    ...history
  ];
  messages.push({ role: "user", content: prompt });
  console.debug('[llmRespond] 入力messages:', JSON.stringify(messages).slice(0, 1000), 'temperature:', temperature);
  const completion = await await queuedOpenAI(() => openai.chat.completions.create({
    model: 'gpt-4.1-nano-2025-04-14',
    messages,
    temperature
  }));
  console.debug('[llmRespond] LLM応答:', completion.choices[0]?.message?.content);
  return completion.choices[0]?.message?.content || "ごめんなさい、うまく答えられませんでした。";
}

// 検索クエリ生成用プロンプト
const queryGenSystemPrompt = "あなたは検索エンジン用のクエリ生成AIです。ユーザーの質問や要望から、Google検索で最も適切な日本語キーワード列（例: '東京 ニュース 今日'）を1行で出力してください。余計な語句や敬語は除き、検索に最適な単語だけをスペース区切りで返してください。";

// 🍃 ちょっとだけ履歴の窓をひらくよ
const LONG_WINDOW  = 50;       // 🧠 森の奥にそっとしまっておく長い記憶
const SUMMARY_AT   = 40;       // ✨ たくさん話したら、まとめて森の記憶にするよ

// 🍃 機能説明リクエストかどうか判定する関数
function isFeatureQuestion(text: string): boolean {
  const patterns = [
    /どんなことができる/, /何ができる/, /機能(を|について)?教えて/, /自己紹介/, /できること/, /使い方/, /help/i
  ];
  return patterns.some(re => re.test(text));
}

// 🍃 検索クエリに日付や話題性ワードを自動付与する関数
function appendDateAndImpactWordsIfNeeded(userPrompt: string, query: string): string {
  const dateWords = [/今日/, /本日/, /最新/];
  const impactWords = [/ニュース/, /話題/, /注目/, /トレンド/, /速報/];
  let newQuery = query;
  // 日付ワード
  if (dateWords.some(re => re.test(userPrompt))) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate() + 1).padStart(2, '0');
    const dateStr = `${yyyy}年${mm}月${dd}日`;
    if (!newQuery.includes(dateStr) && !newQuery.includes('今日') && !newQuery.includes('本日')) {
      newQuery += ` ${dateStr}`;
    }
  }
  // ニュースや話題性ワードが含まれていたら「話題」「注目」「トレンド」を付与
  if (impactWords.some(re => re.test(userPrompt))) {
    if (!/話題/.test(newQuery)) newQuery += ' 話題';
    if (!/注目/.test(newQuery)) newQuery += ' 注目';
    if (!/トレンド/.test(newQuery)) newQuery += ' トレンド';
  }
  return newQuery.trim();
}

// ---- 新: ChatGPT風・自然なWeb検索体験 ----
async function enhancedSearch(userPrompt: string, message: Message, affinity: number, supabase: SupabaseClient): Promise<{ answer: string, results: any[] }> {
  console.debug('[enhancedSearch] 入力:', { userPrompt, affinity });
  let queries: string[] = [];
  for (let i = 0; i < 3; i++) {
    let q = await llmRespond(
      userPrompt,
      queryGenSystemPrompt + `\n【バリエーション${i+1}】できるだけ異なる切り口で。`,
      message,
      [],
      buildCharacterPrompt(message, affinity),
      0 // クエリ生成も事実厳守
    );
    q = appendDateAndImpactWordsIfNeeded(userPrompt, q);
    if (q && !queries.includes(q)) queries.push(q);
  }
  console.debug('[enhancedSearch] 検索クエリ:', queries);
  if (queries.length === 0) {
    console.warn('[enhancedSearch] クエリ生成に失敗。空配列を返します');
    return { answer: '検索クエリ生成に失敗しました。', results: [] };
  }
  let allResults = [];
  let seenLinks = new Set();
  let seenDomains = new Set();
  for (const query of queries) {
    let results = await googleSearch(query);
    console.debug('[enhancedSearch] googleSearch結果:', results);
    if (!results || results.length === 0) {
      console.warn(`[enhancedSearch] googleSearchが空配列を返却。クエリ: ${query}`);
    }
    for (const r of results) {
      const domain = r.link.match(/^https?:\/\/(.*?)(\/|$)/)?.[1] || '';
      if (!seenLinks.has(r.link) && !seenDomains.has(domain)) {
        allResults.push(r);
        seenLinks.add(r.link);
        seenDomains.add(domain);
      }
      if (allResults.length >= MAX_ARTICLES) break;
    }
    if (allResults.length >= MAX_ARTICLES) break;
  }
  if (allResults.length === 0) {
    console.warn('[enhancedSearch] すべてのgoogleSearch結果が空。Web検索結果なしでフォールバックします');
  }
  // 3) ページ取得＆テキスト抽出 or スニペット利用
  let pageContents = await Promise.all(
    allResults.map(async r => {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
          const res = await fetch(r.link, { signal: controller.signal });
          const html = await res.text();
          const $ = load(html);
          let text = $('p').slice(0,5).map((i,el) => $(el).text()).get().join('\n');
          if (!text.trim()) text = r.snippet || '';
          return { title: r.title, text, link: r.link, snippet: r.snippet };
        } finally {
          clearTimeout(timeoutId);
        }
      } catch {
        return { title: r.title, text: r.snippet || '', link: r.link, snippet: r.snippet };
      }
    })
  );
  console.debug('[enhancedSearch] ページ内容抽出結果:', pageContents);
  // 4) LLMで関連度判定し、低いものは除外（temperature:0.3に緩和）
  const relPrompt = (query: string, title: string, snippet: string) =>
    `ユーザーの質問:「${query}」\n検索結果タイトル:「${title}」\nスニペット:「${snippet}」\nこの検索結果は質問に少しでも関係していますか？迷った場合や部分的にでも関係があれば「はい」とだけ返答してください。`;
  const relChecks = await Promise.all(
    pageContents.map(async pg => {
      try {
        const rel = await llmRespond(userPrompt, relPrompt(userPrompt, pg.title, pg.snippet), null, [], null, 0.3);
        console.debug('[enhancedSearch] 関連度判定応答:', rel, 'title:', pg.title);
        return rel.toLowerCase().includes('はい');
      } catch (e) {
        console.debug('[enhancedSearch] 関連度判定例外:', e, 'title:', pg.title);
        return false;
      }
    })
  );
  pageContents = pageContents.filter((pg, i) => relChecks[i]);
  // --- 追加: 関連度判定で全て除外された場合は最初の1件を必ず残す ---
  if (pageContents.length === 0 && allResults.length > 0) {
    console.warn('[enhancedSearch] 関連度判定で全除外→最初の1件を強制採用:', allResults[0]);
    pageContents.push(allResults[0]);
  }
  // 5) Markdown整形・比較/矛盾指摘テンプレート
  const useMarkdown = bocchyConfig.output_preferences?.format === 'markdown';
  if (pageContents.length === 0 || pageContents.every(pg => !pg.text.trim())) {
    // --- fallbackPromptでも検索結果を必ず引用 ---
    let fallbackText = `Web検索では直接的な情報が見つかりませんでしたが、一般的な知識や推論でお答えします。\n\n質問: ${userPrompt}`;
    if (allResults.length > 0) {
      const first = allResults[0];
      fallbackText += `\n\n【参考になりそうな検索結果】\nタイトル: ${first.title}\nスニペット: ${first.snippet}\nURL: ${first.link}`;
      fallbackText += '\n\n【重要】必ず上記の検索結果情報（タイトル・スニペット・URL）を文中で引用し、URLも明記してください。';
    }
    fallbackText += useMarkdown ? '\n\n【出力形式】Markdownで見やすくまとめてください。' : '';
    console.debug('[enhancedSearch][fallbackPrompt] LLMプロンプト全文:', fallbackText);
    const fallbackAnswer = await llmRespond(userPrompt, fallbackText, message, [], buildCharacterPrompt(message, affinity));
    console.debug('[enhancedSearch][fallbackPrompt] LLM応答全文:', fallbackAnswer);
    // --- titleやURLが含まれていなければ自動で追記 ---
    if (allResults.length > 0) {
      const first = allResults[0];
      const mustInclude = [first.title, first.link];
      let needsAppend = false;
      for (const item of mustInclude) {
        if (item && !fallbackAnswer.includes(item)) needsAppend = true;
      }
      let finalAnswer = fallbackAnswer;
      if (needsAppend) {
        finalAnswer += `\n\n【参考情報（自動追記）】\nタイトル: ${first.title}\nURL: ${first.link}`;
      }
      return { answer: finalAnswer, results: allResults.length > 0 ? [allResults[0]] : [] };
    }
    return { answer: fallbackAnswer, results: [] };
  }
  // 比較・矛盾指摘プロンプト
  const docs = pageContents.map((pg,i) => `【${i+1}】${pg.title}\n${pg.text}\nURL: ${pg.link}`).join('\n\n');
  const urlList = pageContents.map((pg,i) => `【${i+1}】${pg.title}\n${pg.link}`).join('\n');
  let systemPrompt =
    `あなたはWeb検索アシスタントです。以下の検索結果を比較し、共通点・矛盾点・重要な違いがあれば明示してください。` +
    `ユーザーの質問「${userPrompt}」に日本語で分かりやすく回答してください。` +
    (useMarkdown ? '\n\n【出力形式】\n- 箇条書きや表を活用し、Markdownで見やすくまとめてください。\n- 参考URLは[1]や【1】のように文中で引用してください。' : '') +
    `\n\n【検索結果要約】\n${docs}\n\n【参考URLリスト】\n${urlList}\n\n` +
    `・信頼できる情報源を優先し、事実ベースで簡潔にまとめてください。\n・必要に応じて参考URLを文中で引用してください。`;
  console.debug('[enhancedSearch] LLM要約プロンプト:', systemPrompt);
  let answer = await llmRespond(userPrompt, systemPrompt, message, [], buildCharacterPrompt(message, affinity));
  console.debug('[enhancedSearch] LLM応答:', answer);
  // --- 修正: 関連度が2件以上ある場合のみ出典URLを付与 ---
  if (pageContents.length >= 2) {
    answer += (useMarkdown ? `\n\n**【出典URL】**\n` : '\n\n【出典URL】\n') + pageContents.map((pg,i) => `【${i+1}】${pg.link}`).join('\n');
  }
  if (supabase) await saveHistory(supabase, message, `[検索クエリ] ${queries[0]}`, docs, affinity);
  return { answer, results: pageContents };
}

// --- saveHistory: 履歴保存の簡易実装 ---
async function saveHistory(supabase: SupabaseClient, message: Message, userMsg: string, botMsg: string, affinity: number): Promise<void> {
  if (!supabase) return;
  try {
    const userId = message.author.id;
    const channelId = message.channel?.id;
    const guildId = message.guild?.id || '';
    // conversation_historiesに追記
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
export async function runPipeline(action: string, { message, flags, supabase }: { message: Message, flags: any, supabase: SupabaseClient }): Promise<void> {
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
    memory.addMessage('user', message.content);

    // --- テスト仕様同期コメント ---
    // テスト（test/handlers/action-runner.test.ts）では「コメントにURLが含まれる場合は必ずfetchPageContentが呼ばれ、LLM応答が返る」ことを期待している。
    // そのため、実装でも必ずURL検出時はfetchPageContent＋LLM要約を実行すること。

    // --- クエリ主導型: 検索・クロール命令が含まれる場合は必ず検索・クロールを実行 ---
    if (/(検索|調べて|天気|ニュース|速報|URL|リンク|要約|まとめて|Web|web|ウェブ|サイト|ページ|情報|教えて|見つけて|リサーチ)/i.test(message.content)) {
      // enhancedSearchで検索・クロール→LLM要約
      const { answer } = await enhancedSearch(message.content, message, affinity, supabase);
      memory.addMessage('assistant', answer);
      await message.reply(answer);
      if (supabase) await updateAffinity(userId, guildId, message.content);
      if (supabase) await saveHistory(supabase, message, message.content, answer, affinity);
      return;
    }

    // --- URLが含まれる場合は必ずfetchPageContent＋LLM要約を実行 ---
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = message.content.match(urlRegex) || [];
    if (urls.length > 0) {
      // 1件目のみ要約（複数URL対応は今後拡張可）
      const url = urls[0];
      let pageContent = '';
      let errorMsg = '';
      try {
        pageContent = await fetchPageContent(url);
      } catch (e) {
        errorMsg = '[fetchPageContentエラー] ' + (e && typeof e === 'object' && 'message' in e ? (e as any).message : String(e));
      }
      let llmAnswer = '';
      if (pageContent && pageContent.length > 50) {
        const systemPromptUrl = `【重要】以下のURL内容を必ず参照し、事実に基づいて答えてください。創作や推測は禁止です。\n----\n${pageContent.slice(0, 2000)}\n----\n`;
        const userPromptUrl = `このURL（${url}）の内容を要約し、特徴を事実ベースで説明してください。創作や推測は禁止です。`;
        llmAnswer = await llmRespond(userPromptUrl, systemPromptUrl, message, [], buildCharacterPrompt(message, affinity));
      } else {
        llmAnswer = errorMsg || 'ページ内容が取得できませんでした。URLが無効か、クロールが制限されている可能性があります。';
      }
      memory.addMessage('assistant', llmAnswer);
      await message.reply(llmAnswer);
      if (supabase) await updateAffinity(userId, guildId, message.content);
      if (supabase) await saveHistory(supabase, message, message.content, llmAnswer, affinity);
      return;
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
      history = memory.getRecentHistory().map(h => h.role === 'bot' ? { ...h, role: 'assistant' } : h);
    }
    // 5. LLM応答生成
    const answer = await llmRespond(userPrompt, systemCharPrompt + systemPrompt + prompt, message, history);
    // --- ボット応答を短期記憶バッファに記録（role: 'assistant'） ---
    memory.addMessage('assistant', answer);
    await message.reply(answer);
    if (supabase) await updateAffinity(userId, guildId, message.content);
    if (supabase) await saveHistory(supabase, message, message.content, answer, affinity);
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

export { enhancedSearch };

async function getGuildMemberNames(guild: Guild, limit: number): Promise<string[]> {
  // TODO: 本実装ではguild.members.fetch()等で取得
  return [];
}

export { getAffinity, buildCharacterPrompt, updateAffinity, saveHistory };