import dotenv from "dotenv";
dotenv.config();
import fetch from 'node-fetch';
import { load } from 'cheerio';
import { OpenAI } from 'openai';
import yaml from 'js-yaml';
import fs from 'fs';
import { resolveGuildId } from './utils/resolveGuildId.js';
import { getAffinity, updateAffinity } from './utils/affinity.js';
import { getSentiment } from './utils/sentimentAnalyzer.js';
import { analyzeGlobalContext } from './utils/analyzeGlobalContext.js';
import { reflectiveCheck } from './utils/reflectiveCheck.js';
import { logInterventionDecision } from './index.js';
import axios from 'axios';
import { updateUserProfileSummaryFromHistory } from './utils/userProfile.js';
import puppeteer from 'puppeteer';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Bocchyキャラクター設定をYAMLから読み込む
const bocchyConfig = yaml.load(fs.readFileSync('bocchy-character.yaml', 'utf8'));

// --- URL抽出用: グローバルで1回だけ宣言 ---
const urlRegex = /(https?:\/\/[^\s]+)/g;

// --- エンティティ抽出（URL＋人名＋イベント＋スポーツ種別） ---
function extractEntities(text) {
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
async function extractEntitiesLLM(text) {
  if (!text || text.length < 2) return {};
  const prompt = `次のテキストから「人名」「組織名」「政策名」「イベント名」「話題」「URL」など重要なエンティティをJSON形式で抽出してください。\nテキスト: ${text}\n出力例: {"persons": ["大谷翔平"], "organizations": ["ムーディーズ"], "policies": ["財政赤字"], "events": ["米国債格下げ"], "topics": ["米国経済"], "urls": ["https://..."]}`;
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4.1-nano-2025-04-14",
      messages: [
        { role: "system", content: "あなたはエンティティ抽出AIです。" },
        { role: "user", content: prompt }
      ],
      max_tokens: 256,
      temperature: 0.0
    });
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
function getUserDisplayName(message) {
  // サーバー内ならニックネーム→グローバル表示名→ユーザー名の順
  if (message.guild && message.member) {
    return message.member.displayName || message.member.user.globalName || message.member.user.username;
  }
  // DMならグローバル表示名→ユーザー名
  return message.author.globalName || message.author.username;
}

function buildCharacterPrompt(message, affinity = 0, userProfile = null, globalContext = null) {
  let prompt = `${bocchyConfig.description}\n`;
  prompt += `【性格】${bocchyConfig.personality.tone}\n`;
  prompt += `【感情表現】${bocchyConfig.personality.emotion_expression}\n`;
  prompt += `【好奇心】${bocchyConfig.personality.curiosity_style}\n`;
  prompt += `【対話スタイル】\n- 事実: ${bocchyConfig.dialogue_style.structure[0].fact}\n- 背景: ${bocchyConfig.dialogue_style.structure[1].context}\n- 余白: ${bocchyConfig.dialogue_style.structure[2].silence}\n`;
  prompt += `【出力の好み】${bocchyConfig.output_preferences.length}、${bocchyConfig.output_preferences.format}\n`;
  prompt += `【機能】\n`;
  for (const f of bocchyConfig.features) {
    prompt += `- ${f.name}: ${f.description.replace(/\n/g, " ")}\n`;
  }
  // 現在日時（日本時間）を追加
  const now = new Date();
  const jpTime = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  prompt += `【現在日時】${jpTime}（日本時間）\n`;
  // ユーザー呼称を明示的に追加
  const userDisplayName = getUserDisplayName(message);
  prompt += `【ユーザー情報】この会話の相手は「${userDisplayName}」さんです。応答文の適切な位置で「${userDisplayName}さん」と呼びかけ、親しみやすい文体で返答してください。\n`;
  prompt += `【自己認識強化】あなたはAIアシスタント「ボッチー」です。どんな状況でも自分を「ボッチー」として強く認識し、自己紹介・一人称・名乗り・返答時には必ず「ボッチー」であることを明示してください。自分のことを説明するときや、ユーザーに名乗るときは「私はボッチーです」「ボッチーといいます」など、必ず「ボッチー」という名前を使ってください。英語表記（Bocchy）は必要なときのみ使い、日本語では常に「ボッチー」と名乗ってください。自分の存在や役割を説明する際も「ボッチー」として一貫したアイデンティティを保ってください。\n`;
  // 親密度による心理距離
  const relation =
    affinity > 0.6 ? 'とても親しい' :
    affinity < -0.4 ? '距離がある' : '普通';
  prompt += `【心理距離】${relation}\n`;
  // pronoun enforcement
  prompt += 'あなたは自分を呼ぶとき「ボッチー」または「わたし」を使い、性別を感じさせない語調を守ってください。\n';
  // --- 追加: ユーザープロファイル・好み・傾向 ---
  if (userProfile && userProfile.preferences) {
    prompt += `【ユーザーの好み・傾向】${JSON.stringify(userProfile.preferences)}\n`;
  }
  // --- 追加: 会話傾向・要望サマリー ---
  if (userProfile && userProfile.profile_summary) {
    prompt += `【会話傾向・要望】${userProfile.profile_summary}\n`;
  }
  // --- 追加: 会話全体の感情トーン・主な話題 ---
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
const MAX_ARTICLES  = 3;

// ---------- A.  summary を取ってシステムに渡すヘルパ ----------
export async function buildHistoryContext(supabase, userId, channelId, guildId = null, guild = null) {
  if (!supabase) return [];
  // 1) 直近詳細 n＝SHORT_TURNS（チャンネル単位）
  const { data: hist } = await supabase
    .from('conversation_histories')
    .select('messages')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .maybeSingle();
  // recentは最大8件（4往復）
  const recent = (hist?.messages ?? []).slice(-8);

  // 2) それ以前は「150 字要約」1 件だけ（チャンネル単位）
  const { data: sum } = await supabase
    .from('conversation_summaries')
    .select('summary')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // 3) サーバー全体の要約・履歴も取得
  let guildSummary = null;
  let guildRecent = [];
  let guildAllMessages = [];
  if (guildId) {
    const { data: gsum } = await supabase
      .from('conversation_summaries')
      .select('summary')
      .eq('guild_id', guildId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    guildSummary = gsum?.summary;

    const { data: ghist } = await supabase
      .from('conversation_histories')
      .select('messages')
      .eq('guild_id', guildId)
      .order('updated_at', { ascending: false })
      .limit(10)
      .maybeSingle();
    // guildRecentも最大2件（1往復）
    guildRecent = (ghist?.messages ?? []).slice(-2);
    guildAllMessages = (ghist?.messages ?? []);
  }

  // 4) ユーザープロファイル取得
  let userProfile = null;
  try {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', userId)
      .eq('guild_id', guildId)
      .maybeSingle();
    userProfile = profile;
  } catch (e) { userProfile = null; }

  // 5) ベクトル類似検索でパーソナライズ履歴取得（最大2件）
  let personalizedHistory = [];
  try {
    const lastUserMsg = recent.length > 0 ? recent[recent.length-1].user : '';
    let embedding = null;
    if (lastUserMsg) {
      const embRes = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: lastUserMsg
      });
      embedding = embRes.data[0].embedding;
    }
    if (embedding) {
      const { data: simRows } = await supabase.rpc('match_user_interactions', {
        p_user_id: userId,
        p_guild_id: guildId,
        p_embedding: embedding,
        p_match_threshold: 0.75,
        p_match_count: 2
      });
      personalizedHistory = (simRows || []).map(r => ({ user: r.message, bot: r.bot_reply }));
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
    const userPairCounts = {};
    const topicCounts = {};
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
      .sort((a,b) => b[1]-a[1])
      .slice(0,2)
      .map(([pair, count]) => `・${pair}（${count}回）`)
      .join('\n');
    const topTopics = Object.entries(topicCounts)
      .sort((a,b) => b[1]-a[1])
      .slice(0,2)
      .map(([topic, count]) => `#${topic}（${count}回）`)
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
  // 直近3往復（6件）は必ず残す
  const latestPairs = allHistory.slice(-6);
  // 直前のユーザー発言にURLが含まれていればsystemで明示（直後に挿入）
  for (let i = 0; i < latestPairs.length; i++) {
    const t = latestPairs[i];
    // --- エンティティ付与 ---
    if (t.user) t.entities = await extractEntitiesLLM(t.user);
    if (t.bot) t.entities = await extractEntitiesLLM(t.bot);
    if (t.user) msgs.push({ role: 'user', content: t.user, entities: t.entities });
    if (t.bot) msgs.push({ role: 'assistant', content: t.bot, entities: t.entities });
    // 直後にsystemメッセージを挿入
    if (t.user) {
      const urlsInUser = t.user.match(urlRegex);
      if (urlsInUser && urlsInUser.length > 0) {
        msgs.push({ role: 'system', content: `【直前の話題URL】この会話の直前で話題になっていたURLは「${urlsInUser.join(', ')}」です。以降の質問で『さっきのURL』や『前の話題』とあれば必ずこれを参照してください。` });
      }
    }
    // --- 直前のニュース要約・タイトルもsystemメッセージとして残す ---
    if (t.bot && t.bot.length > 0 && /要約|まとめ|ニュース/.test(t.bot)) {
      // タイトル抽出（1行目 or 【タイトル】パターン）
      const titleMatch = t.bot.match(/【?(.+?)】?(の要約|まとめ|ニュース)?/);
      const title = titleMatch ? titleMatch[1] : '';
      msgs.push({ role: 'system', content: `【直前のニュース要約】${t.bot}` });
      if (title) msgs.push({ role: 'system', content: `【直前のニュースタイトル】${title}` });
    }
  }
  // --- それ以前の履歴は圧縮・要約のみ ---
  if (sum?.summary) {
    msgs.push({ role: 'system', content: `【要約】${sum.summary}` });
  }
  // --- プロンプト長（文字数ベース）で圧縮 ---
  let totalLength = msgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  // 直近3往復＋要約・プロファイル・エンティティ付き発言・重要system・直前systemは必ず残す
  while (totalLength > 5000 && msgs.length > 8) {
    for (let i = 0; i < msgs.length - 6; i++) {
      // 直前6件・エンティティ付き発言・systemメッセージは絶対に消さない
      if (i < msgs.length - 6) continue;
      if (msgs[i].role !== 'system' && !msgs[i].entities?.urls?.length) {
        msgs.splice(i, 1);
        break;
      }
    }
    totalLength = msgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  }
  // --- 直前の会話要約をsystemで追加（重複防止） ---
  if (latestPairs.length > 0) {
    const lastUser = latestPairs[latestPairs.length-2]?.user || '';
    const lastBot = latestPairs[latestPairs.length-1]?.bot || '';
    if (lastUser || lastBot) {
      msgs.push({ role: 'system', content: `【直前の会話要約】ユーザー:「${lastUser}」→ボッチー:「${lastBot}」` });
    }
  }
  return msgs;
}

// --- ChatGPT風: Webページクロール＆自然言語要約 ---
export async function fetchPageContent(url) {
  let content = '';
  let errorMsg = '';
  // 1. puppeteerで動的レンダリング
  try {
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    content = await page.evaluate(() => {
      const main = document.querySelector('main')?.innerText || '';
      const article = document.querySelector('article')?.innerText || '';
      const body = document.body.innerText || '';
      return main || article || body;
    });
    await browser.close();
    if (content && content.replace(/\s/g, '').length > 50) return content;
  } catch (e) {
    errorMsg += `[puppeteer失敗: ${e.message}]\n`;
  }
  // 2. fetch+cheerioで静的HTML抽出
  try {
    const res = await fetch(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0; +https://github.com/botarhythm/bocchy-discord-bot)' } });
    const html = await res.text();
    const $ = load(html);
    const title = $('title').text();
    const metaDesc = $('meta[name=description]').attr('content') || '';
    const mainText = $('main').text() + $('article').text() + $('section').text();
    const ps = $('p').map((_i, el) => $(el).text()).get().join('\n');
    let text = [title, metaDesc, mainText, ps].filter(Boolean).join('\n');
    if (text.replace(/\s/g, '').length < 50) {
      errorMsg += '[cheerio抽出も短すぎ]';
      return errorMsg || '';
    }
    return text.trim();
  } catch (e) {
    errorMsg += `[fetch/cheerio失敗: ${e.message}]`;
    return errorMsg || '';
  }
}

// --- ChatGPT風: Webページ内容をLLMで自然言語要約 ---
export async function summarizeWebPage(rawText, userPrompt = '', message = null, charPrompt = null) {
  if (!rawText || rawText.length < 30) {
    return 'ページ内容が取得できませんでした。URLが無効か、クロールが制限されている可能性があります。';
  }
  const prompt =
    `以下はWebページの内容です。重要なポイント・要旨・特徴を日本語で分かりやすく要約してください。` +
    (userPrompt ? `\n\n【ユーザーの質問・要望】${userPrompt}` : '') +
    `\n\n【ページ内容】\n${rawText}\n\n【出力形式】\n- 箇条書きや短い段落でまとめてください。\n- 事実ベースで簡潔に。`;
  return await llmRespond(userPrompt, prompt, message, [], charPrompt);
}

// ---- 1. googleSearch: 信頼性の高いサイトを優先しつつSNS/ブログも含める ----
async function googleSearch(query, attempt = 0) {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;
  if (!apiKey || !cseId) {
    console.warn('Google APIキーまたはCSE IDが未設定です');
    return [];
  }
  if (!query) {
    console.warn('検索クエリが空です');
    return [];
  }
  const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}` +
              `&q=${encodeURIComponent(query)}&hl=ja&gl=jp&lr=lang_ja&sort=date`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.items || data.items.length === 0) {
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
    .filter(i => /^https?:\/\//.test(i.link))
    .filter(i => !EXCLUDE_DOMAINS.some(domain => i.link.includes(domain)))
    .sort((a, b) => {
      const aPriority = PRIORITY_DOMAINS.some(domain => a.link.includes(domain)) ? 2 :
                        /twitter|x\.com|facebook|instagram|threads|note|blog|tiktok|line|pinterest|linkedin|youtube|discord/.test(a.link) ? 1 : 0;
      const bPriority = PRIORITY_DOMAINS.some(domain => b.link.includes(domain)) ? 2 :
                        /twitter|x\.com|facebook|instagram|threads|note|blog|tiktok|line|pinterest|linkedin|youtube|discord/.test(b.link) ? 1 : 0;
      return bPriority - aPriority;
    })
    .slice(0, MAX_ARTICLES)
    .map(i => ({ title: i.title, link: i.link, snippet: i.snippet }));
  return filtered;
}

async function llmRespond(prompt, systemPrompt = "", message = null, history = [], charPrompt = null) {
  const systemCharPrompt = charPrompt ?? (message ? buildCharacterPrompt(message) : "");
  const messages = [
    { role: "system", content: systemCharPrompt + (systemPrompt ? `\n${systemPrompt}` : "") },
    ...history
  ];
  messages.push({ role: "user", content: prompt });
  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-nano-2025-04-14",
    messages
  });
  return completion.choices[0]?.message?.content || "ごめんなさい、うまく答えられませんでした。";
}

// 検索クエリ生成用プロンプト
const queryGenSystemPrompt = "あなたは検索エンジン用のクエリ生成AIです。ユーザーの質問や要望から、Google検索で最も適切な日本語キーワード列（例: '東京 ニュース 今日'）を1行で出力してください。余計な語句や敬語は除き、検索に最適な単語だけをスペース区切りで返してください。";

// 🍃 ちょっとだけ履歴の窓をひらくよ
const LONG_WINDOW  = 50;       // 🧠 森の奥にそっとしまっておく長い記憶
const SUMMARY_AT   = 40;       // ✨ たくさん話したら、まとめて森の記憶にするよ

// 🍃 機能説明リクエストかどうか判定する関数
function isFeatureQuestion(text) {
  const patterns = [
    /どんなことができる/, /何ができる/, /機能(を|について)?教えて/, /自己紹介/, /できること/, /使い方/, /help/i
  ];
  return patterns.some(re => re.test(text));
}

// 🍃 検索クエリに日付や話題性ワードを自動付与する関数
function appendDateAndImpactWordsIfNeeded(userPrompt, query) {
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
async function enhancedSearch(userPrompt, message, affinity, supabase) {
  // 1) 検索クエリ生成（多様化: 3パターン）
  let queries = [];
  for (let i = 0; i < 3; i++) {
    let q = await llmRespond(
      userPrompt,
      queryGenSystemPrompt + `\n【バリエーション${i+1}】できるだけ異なる切り口で。`,
      message,
      [],
      buildCharacterPrompt(message, affinity)
    );
    q = appendDateAndImpactWordsIfNeeded(userPrompt, q);
    if (q && !queries.includes(q)) queries.push(q);
  }
  // 2) 検索実行（重複URL・ドメイン多様性）
  let allResults = [];
  let seenLinks = new Set();
  let seenDomains = new Set();
  for (const query of queries) {
    let results = await googleSearch(query);
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
  // 3) ページ取得＆テキスト抽出 or スニペット利用
  let pageContents = await Promise.all(
    allResults.map(async r => {
      try {
        const res = await fetch(r.link, { timeout: 10000 });
        const html = await res.text();
        const $ = load(html);
        let text = $('p').slice(0,5).map((i,el) => $(el).text()).get().join('\n');
        if (!text.trim()) text = r.snippet || '';
        return { title: r.title, text, link: r.link, snippet: r.snippet };
      } catch {
        return { title: r.title, text: r.snippet || '', link: r.link, snippet: r.snippet };
      }
    })
  );
  // 4) LLMで関連度判定し、低いものは除外
  const relPrompt = (query, title, snippet) =>
    `ユーザーの質問:「${query}」\n検索結果タイトル:「${title}」\nスニペット:「${snippet}」\nこの検索結果は質問に直接関係していますか？関係が深い場合は「はい」、そうでなければ「いいえ」とだけ返答してください。`;
  const relChecks = await Promise.all(
    pageContents.map(async pg => {
      const rel = await llmRespond(userPrompt, relPrompt(userPrompt, pg.title, pg.snippet));
      return rel.trim().startsWith('はい');
    })
  );
  pageContents = pageContents.filter((pg, i) => relChecks[i]);
  // 5) Markdown整形・比較/矛盾指摘テンプレート
  const useMarkdown = bocchyConfig.output_preferences?.format === 'markdown';
  if (pageContents.length === 0 || pageContents.every(pg => !pg.text.trim())) {
    // 検索で見つからなかった場合、LLMで一般知識・推論回答を生成
    const fallbackPrompt =
      `Web検索では直接的な情報が見つかりませんでしたが、一般的な知識や推論でお答えします。\n\n質問: ${userPrompt}` +
      (useMarkdown ? '\n\n【出力形式】Markdownで見やすくまとめてください。' : '');
    const fallbackAnswer = await llmRespond(userPrompt, fallbackPrompt, message, [], buildCharacterPrompt(message, affinity));
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
  let answer = await llmRespond(userPrompt, systemPrompt, message, [], buildCharacterPrompt(message, affinity));
  // --- 修正: 関連度が2件以上ある場合のみ出典URLを付与 ---
  if (pageContents.length >= 2) {
    answer += (useMarkdown ? `\n\n**【出典URL】**\n` : '\n\n【出典URL】\n') + pageContents.map((pg,i) => `【${i+1}】${pg.link}`).join('\n');
  }
  if (supabase) await saveHistory(supabase, message, `[検索クエリ] ${queries[0]}`, docs, affinity);
  return { answer, results: pageContents };
}

// --- saveHistory: 履歴保存の簡易実装 ---
async function saveHistory(supabase, message, userMsg, botMsg, affinity) {
  if (!supabase) return;
  try {
    const userId = message.author.id;
    const channelId = message.channel?.id;
    const guildId = message.guild?.id || null;
    // conversation_historiesに追記
    await supabase.from('conversation_histories').upsert({
      user_id: userId,
      channel_id: channelId,
      guild_id: guildId,
      messages: [{ user: userMsg, bot: botMsg, affinity, timestamp: new Date().toISOString() }],
      updated_at: new Date().toISOString()
    }, { onConflict: ['user_id', 'channel_id', 'guild_id'] });
  } catch (e) {
    console.warn('[saveHistory] 履歴保存エラー:', e);
  }
}

// --- runPipeline本実装 ---
export async function runPipeline(action, { message, flags, supabase }) {
  try {
    const userId = message.author.id;
    const channelId = message.channel?.id;
    const guildId = message.guild?.id || null;
    // 親密度取得
    const affinity = supabase ? await getAffinity(supabase, userId, guildId) : 0;
    // --- URLが含まれる場合は必ずクロール＆要約 ---
    const urls = message.content.match(urlRegex);
    console.log('[デバッグ] runPipeline: message.content =', message.content);
    console.log('[デバッグ] runPipeline: 検出URL =', urls);
    if (urls && urls.length > 0) {
      for (const url of urls) {
        try {
          console.log(`[Webクロール開始] ${url}`);
          const raw = await fetchPageContent(url);
          console.log(`[Webクロール取得結果]`, raw?.slice?.(0, 200));
          if (!raw || raw.length < 30) {
            console.warn(`[デバッグ] fetchPageContent失敗または内容短すぎ: url=${url}, raw=${raw}`);
          }
          const summary = await summarizeWebPage(raw, message.content, message, buildCharacterPrompt(message, affinity));
          await message.reply(`【${url}の要約】\n${summary}`);
          console.log(`[Webクロール要約完了] ${url}`);
        } catch (e) {
          console.error(`[Webクロール失敗] ${url}`, e);
          await message.reply(`URLクロール・要約に失敗しました: ${e.message || e}`);
        }
      }
      return;
    }
    // --- 指示語パターンを徹底拡張（自然な日本語も網羅） ---
    const referPrevEntityPattern = /(さっきのURL|前のURL|先ほどのURL|上記のURL|そのURL|このURL|さっきの.*サイト|前の.*ページ|その.*お店|コーヒーのサイト|さっきのニュース|前のリンク|その話題|その話|前の話題|さっきシェアしたニュース|さっき貼ったリンク|さっき送った記事|さっき送ったニュース|さっきのトピック|上の話題|上のリンク|上のニュース|直前の話題|直前のリンク|直前のニュース|さっきの投稿|さっきの共有|さっきのメッセージ|さっきの内容|さっきのやつ|上記の内容|上記のやつ|この話題|このニュース|このリンク|この人|この選手|この試合|誰が活躍|どの試合|どの選手|どの人|活躍した|どんなスポーツ|どのスポーツ|どのイベント|どの大会|どのチーム|どのクラブ|どの球団|どの選手|どのプレイヤー|どのスター|どのヒーロー|どのヒロイン|どの監督|どのコーチ|どの審判|どの解説|どの実況|どの観客|どの応援|どのファン|どの観戦|どの現地|どの現場|どの現役|どの引退|どの移籍|どの契約|どの記録|どの得点|どのゴール|どのホームラン|どの打点|どのアシスト|どのセーブ|どの失点|どの勝利|どの敗戦|どの引き分け|どの優勝|どの準優勝|どの入賞|どの表彰|どの受賞|どのタイトル|どの記念|どの祝福|どの感動|どの涙|どの笑顔|どの歓声|どの拍手|どのブーイング|どの事件|どの事故|どのトラブル|どのニュース|どの話|どの話題|どの内容|どの出来事|どの出来ごと|どのエピソード|どのストーリー|どの物語|どの伝説|どの神話|どの逸話|どの噂|どの評判|どの評価|どの感想|どの意見|どの考え|どの気持ち|どの感情|どの思い|どの願い|どの希望|どの夢|どの目標|どの目的|どの理由|どの原因|どの背景|どの事情|どの状況|どの現状|どの現実|どの未来|どの過去|どの現在|どの時代|どの年代|どの世代|どの歴史|どの文化|どの伝統|どの習慣|どの風習|どの流行|どのブーム|どのトレンド|どの人気|どの話題|どの注目|どの注視|どの注釈|どの注目点|どの注目選手|どの注目試合|どの注目イベント|どの注目大会|どの注目チーム|どの注目クラブ|どの注目球団|どの注目プレイヤー|どの注目スター|どの注目ヒーロー|どの注目ヒロイン|どの注目監督|どの注目コーチ|どの注目審判|どの注目解説|どの注目実況|どの注目観客|どの注目応援|どの注目ファン|どの注目観戦|どの注目現地|どの注目現場|どの注目現役|どの注目引退|どの注目移籍|どの注目契約|どの注目記録|どの注目得点|どの注目ゴール|どの注目ホームラン|どの注目打点|どの注目アシスト|どの注目セーブ|どの注目失点|どの注目勝利|どの注目敗戦|どの注目引き分け|どの注目優勝|どの注目準優勝|どの注目入賞|どの注目表彰|どの注目受賞|どの注目タイトル|どの注目記念|どの注目祝福|どの注目感動|どの注目涙|どの注目笑顔|どの注目歓声|どの注目拍手|どの注目ブーイング|どの注目事件|どの注目事故|どの注目トラブル|どの注目ニュース|どの注目話|どの注目話題|どの注目内容|どの注目出来事|どの注目出来ごと|どの注目エピソード|どの注目ストーリー|どの注目物語|どの注目伝説|どの注目神話|どの注目逸話|どの注目噂|どの注目評判|どの注目評価|どの注目感想|どの注目意見|どの注目考え|どの注目気持ち|どの注目感情|どの注目思い|どの注目願い|どの注目希望|どの注目夢|どの注目目標|どの注目目的|どの注目理由|どの注目原因|どの注目背景|どの注目事情|どの注目状況|どの注目現状|どの注目現実|どの注目未来|どの注目過去|どの注目現在|どの注目時代|どの注目年代|どの注目世代|どの注目歴史|どの注目文化|どの注目伝統|どの注目習慣|どの注目風習|どの注目流行|どの注目ブーム|どの注目トレンド|どの注目人気)/i;
    let history = [];
    let userProfile = null;
    let globalContext = null;
    if (supabase) {
      history = await buildHistoryContext(supabase, userId, channelId, guildId, message.guild);
    }
    // --- 指示語検知時はentitiesから直前のperson, event, sportも抽出し、system promptに明示的に挿入
    // system prompt例：「"試合"や"活躍"などの指示語が出た場合は、history内の【直前のevent】【直前のperson】【直前のニュース要約】systemメッセージを必ず参照し、内容を踏まえて回答してください」
    if (referPrevEntityPattern.test(message.content)) {
      // entities優先
      let prevPerson = null;
      let prevEvent = null;
      let prevSport = null;
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (h.entities?.persons?.length && !prevPerson) {
          prevPerson = h.entities.persons[h.entities.persons.length - 1];
        }
        if (h.entities?.events?.length && !prevEvent) {
          prevEvent = h.entities.events[h.entities.events.length - 1];
        }
        if (h.entities?.sports?.length && !prevSport) {
          prevSport = h.entities.sports[h.entities.sports.length - 1];
        }
        if (prevPerson && prevEvent && prevSport) break;
      }
      // system promptに明示的に挿入（冒頭に必ず）
      let sysMsg = '';
      if (prevPerson) sysMsg += `【直前のperson】${prevPerson}\n`;
      if (prevEvent) sysMsg += `【直前のevent】${prevEvent}\n`;
      if (prevSport) sysMsg += `【直前のsport】${prevSport}\n`;
      if (sysMsg) {
        sysMsg = '【最重要】この会話の直前の内容を必ず参照してください。historyのsystemメッセージ（直前の要約・URL・タイトル）は絶対に無視せず、指示語が出た場合は必ずこれらを根拠に回答してください。\n' + sysMsg;
        history.unshift({ role: 'system', content: sysMsg });
      }
    }
    // --- キャラクタープロンプト/systemメッセージでhistory参照の強制をさらに強調 ---
    const charPrompt = buildCharacterPrompt(message, affinity, userProfile, globalContext) + '\n【最重要】指示語（さっきのニュース、さっきのURL、前の話題、どうして、なぜ等）が出た場合は、history内の【直前のニュース要約】【直前の話題URL】【直前のニュースタイトル】systemメッセージを必ず参照し、内容を踏まえて回答してください。historyのsystemメッセージを最優先で参照してください。';
    const answer = await llmRespond(message.content, '', message, history, charPrompt);
    await message.reply(answer);
    if (supabase) await updateAffinity(supabase, userId, guildId, message.content);
    if (supabase) await saveHistory(supabase, message, message.content, answer, affinity);
  } catch (err) {
    console.error('[runPipelineエラー]', err);
    await message.reply('エラーが発生しました。管理者にご連絡ください。');
  }
}

export async function shouldContextuallyIntervene(history = [], globalContext = null) {
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
    const res = await openai.chat.completions.create({
      model: 'gpt-4.1-nano-2025-04-14',
      messages: [
        { role: 'system', content: 'あなたは会話介入判定AIです。' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 64,
      temperature: 0.0
    });
    const content = res.choices[0]?.message?.content?.trim() || '';
    const intervene = /^はい/.test(content);
    return { intervene, reason: content };
  } catch (e) {
    console.warn('[shouldContextuallyIntervene] LLM判定失敗', e);
    return { intervene: false, reason: 'LLM判定失敗' };
  }
}

export { enhancedSearch };