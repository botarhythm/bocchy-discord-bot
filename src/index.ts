import { Client, GatewayIntentBits, Partials, ChannelType, Message, Guild, TextChannel } from "discord.js";
import type { PartialMessage, Interaction, ChatInputCommandInteraction } from "discord.js";
import dotenv from "dotenv";
import { openai } from './services/openai.js';
import { supabase } from './services/supabase.js';
import { detectFlags } from "./flag-detector.js";
import { pickAction } from "./decision-engine.js";
import { runPipeline, shouldContextuallyIntervene, buildHistoryContext, getAffinity, buildCharacterPrompt, updateAffinity, saveHistory, deepCrawl, summarizeWebPage, fetchPageContent, enhancedSearch } from "./action-runner.js";
import http from 'http';
import { BOT_CHAT_CHANNEL, MAX_ACTIVE_TURNS, MAX_BOT_CONVO_TURNS, MAX_DAILY_RESPONSES, RESPONSE_WINDOW_START, RESPONSE_WINDOW_END, EMERGENCY_STOP } from './config/index.js';

dotenv.config();

process.on('unhandledRejection', (reason, p) => {
  console.error('[UNHANDLED REJECTION]', reason);
  if (reason && typeof reason === 'object' && 'stack' in reason) {
    console.error('[STACK TRACE]', (reason as any).stack);
  }
  // 追加: 環境情報・起動引数・バージョン
  console.error('[DEBUG:ENV]', {
    NODE_ENV: process.env.NODE_ENV,
    BOT_ENABLED: process.env.BOT_ENABLED,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '***' : undefined,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ? '***' : undefined,
    GOOGLE_CSE_ID: process.env.GOOGLE_CSE_ID ? '***' : undefined,
    RAILWAY_ENV: process.env.RAILWAY_ENV,
    argv: process.argv,
    cwd: process.cwd(),
    version: process.version
  });
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  if (err && err.stack) {
    console.error('[STACK TRACE]', err.stack);
  }
  // 追加: 環境情報・起動引数・バージョン
  console.error('[DEBUG:ENV]', {
    NODE_ENV: process.env.NODE_ENV,
    BOT_ENABLED: process.env.BOT_ENABLED,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? '***' : undefined,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ? '***' : undefined,
    GOOGLE_CSE_ID: process.env.GOOGLE_CSE_ID ? '***' : undefined,
    RAILWAY_ENV: process.env.RAILWAY_ENV,
    argv: process.argv,
    cwd: process.cwd(),
    version: process.version
  });
});

if (process.env.BOT_ENABLED !== "true") {
  console.log("🚫 Bocchy bot is disabled by .env");
  process.exit(0);
}

if (EMERGENCY_STOP) {
  console.log("🚨 EMERGENCY_STOPが有効化されています。ボットを完全停止します。");
  process.exit(0);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

client.once("ready", () => {
  if (client.user) {
    console.log(`✅ Bocchy bot started as ${client.user.tag}`);
  } else {
    console.log('✅ Bocchy bot started (user unknown)');
  }
});

// --- 型定義 ---
interface BotSettings {
  INTERVENTION_LEVEL: number;
  INTERVENTION_QUERIES: string[];
}

interface InterventionContext {
  aiInterventionResult?: { intervene: boolean };
  [key: string]: any;
}

// 設定の初期化
let settings: BotSettings = {
  INTERVENTION_LEVEL: parseInt(process.env.INTERVENTION_LEVEL || '4'),
  INTERVENTION_QUERIES: process.env.INTERVENTION_QUERIES
    ? process.env.INTERVENTION_QUERIES.split(',').map(q => q.trim())
    : ["ニュース", "最新", "困った", "教えて"]
};

function isInterventionQuery(message: Message): boolean {
  return settings.INTERVENTION_QUERIES.some(q => message.content.includes(q));
}

// 介入判定の統合関数（トリガーと文脈フォローを分離）
function shouldInterveneUnified(message: Message, context: InterventionContext = {}): boolean {
  // 1. 明示的トリガー
  if (isExplicitMention(message) || isInterventionQuery(message)) {
    logInterventionDecision('explicit_mention_or_query', message);
    // トリガー時のみ介入度で判定
    return Math.random() < settings.INTERVENTION_LEVEL / 10;
  }
  // 2. 文脈フォロー（AI判定・長期記憶活用）
  if (context.aiInterventionResult && context.aiInterventionResult.intervene) {
    // 文脈フォロー時はAI・履歴・長期記憶を最大限活用し、確率でカットしない
    logInterventionDecision('ai_contextual_follow', message);
    return true;
  }
  // 3. 通常の介入度判定
  if (settings.INTERVENTION_LEVEL <= 0) return false;
  if (settings.INTERVENTION_LEVEL >= 10) return true;
  const result = Math.random() < settings.INTERVENTION_LEVEL / 10;
  if (result) logInterventionDecision('random', message);
  return result;
}

function logInterventionDecision(reason: string, message: Message): void {
  console.log(`[介入判定] reason=${reason}, user=${message.author?.username}, content=${message.content}`);
}
export { logInterventionDecision };

function logMetric(metricName: string, value: any): void {
  console.log(`[メトリクス] ${metricName}: ${value}`);
}

// JST現在時刻取得ヘルパー
function getNowJST(): Date {
  return new Date(new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
}

// 時間帯ごとの日本語挨拶
function greetingJp(date: Date): string {
  const h = date.getHours();
  if (h < 4) return 'こんばんは';
  if (h < 11) return 'おはようございます';
  if (h < 18) return 'こんにちは';
  return 'こんばんは';
}

function isExplicitMention(message: Message): boolean {
  // メンションまたは「ボッチー」という名前が含まれる場合
  if (client.user && message.mentions.has(client.user)) return true;
  if (message.content && message.content.includes("ボッチー")) return true;
  return false;
}

// --- AI盛り上がり判定＋動的クールダウン ---
const channelHistories = new Map();
const interventionCooldowns = new Map();
// 直前の介入メッセージをチャンネルごとに記録
let lastInterventions = new Map();

// 自然介入のフォールバック送信済みチャネルを管理
let fallbackSentChannels = new Set();

// --- 追加: 介入後の積極応答モード管理 ---
const activeConversationMap = new Map(); // channelId => { turns: number, lastUserId: string|null }

// --- ボットごとの会話管理 ---
let botConvoState = new Map(); // botId => { turns, dailyCount, lastResetDate }
let botSilenceUntil: number | null = null; // Date|null: 応答停止終了時刻

/** 日本時間の今日の日付文字列(YYYY/MM/DD)を返す */
function getTodayDate() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[0];
}

// --- チャンネルごとの直近URL・要約の短期記憶 ---
const recentUrlMap = new Map(); // channelId => { url: string, summary: string, timestamp: number }

function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

client.on("messageCreate", async (message) => {
  const isBot = message.author.bot;
  const isHuman = !isBot;
  const botId = message.author.id;
  const channelId = message.channel?.id;
  const userId = message.author.id;
  const isAdmin = message.member?.permissions?.has('Administrator') || false;
  const urls = extractUrls(message.content);

  // --- DMは常に通常応答 ---
  if (!message.guild) {
    if (client.user && message.author.id === client.user.id) return;
    const flags = detectFlags(message, client);
    const action = pickAction(flags);
    if (!action) return;
    try {
      await runPipeline(action, { message, flags, supabase });
    } catch (err) {
      console.error('[DM応答エラー]', err);
      await message.reply('エラーが発生しました。管理者にご連絡ください。');
    }
    return;
  }

  // --- 応答停止中の解除判定（メンション時） ---
  if (botSilenceUntil && client.user && message.mentions.has(client.user)) {
    if (Date.now() < botSilenceUntil) {
      botSilenceUntil = null;
      await message.reply('森から帰ってきたよ🌲✨');
      return;
    }
  }

  // --- 応答停止中は何も返さない ---
  if (botSilenceUntil && Date.now() < botSilenceUntil) return;

  // --- 「静かに」コマンドで10分間応答停止 ---
  if (/静かに/.test(message.content)) {
    botSilenceUntil = Date.now() + 10 * 60 * 1000;
    await message.reply('10分間森へ遊びに行ってきます…🌲');
    return;
  }

  // --- URLが含まれていれば即時要約・記憶 ---
  if (urls.length > 0) {
    let summarized = '';
    let crawlError = null;
    try {
      await message.reply('URLをディープクロール中です…');
      summarized = await summarizeWebPage(urls[0]);
    } catch (e) {
      crawlError = e instanceof Error ? e.message : String(e);
    }
    if (!summarized || /取得できません|エラー|not found|failed|unavailable/i.test(summarized)) {
      await message.reply(`Webクロール失敗: ${crawlError || '本文が取得できませんでした。'}`);
      return;
    }
    recentUrlMap.set(channelId, { url: urls[0], summary: summarized, timestamp: Date.now() });
    await message.reply(`【URLディープクロール要約】\n${summarized.slice(0, 1500)}`);
    return;
  }

  // --- 検索ニーズがある場合（例: "教えて", "特徴", "検索" など） ---
  const searchKeywords = ["教えて", "特徴", "検索", "調べて", "とは", "まとめ", "要約", "解説"];
  if (searchKeywords.some(k => message.content.includes(k))) {
    let searchError = null;
    let searchResults: { answer: string, results: any[] } | null = null;
    try {
      await message.reply('Google検索中です…');
      searchResults = await enhancedSearch(message.content, message, 0, supabase);
    } catch (e) {
      searchError = e instanceof Error ? e.message : String(e);
    }
    if (!searchResults || !searchResults.results || !searchResults.results.length) {
      await message.reply(`Google検索失敗: ${searchError || '検索結果が取得できませんでした。'}`);
      return;
    }
    await message.reply(searchResults.answer);
    return;
  }

  // --- 人間の発言には必ず応答（BOT_CHAT_CHANNEL含む） ---
  if (isHuman) {
    const flags = detectFlags(message, client);
    const action = pickAction(flags);
    if (!action) return;
    try {
      await runPipeline(action, { message, flags, supabase });
    } catch (err) {
      console.error('[人間応答エラー]', err);
      await message.reply('エラーが発生しました。管理者にご連絡ください。');
    }
    botConvoState.clear();
    return;
  }

  // --- ボット同士会話制御（BOT_CHAT_CHANNEL限定） ---
  if (isBot && channelId === BOT_CHAT_CHANNEL && client.user && botId !== client.user.id) {
    const hour = getNowJST().getHours();
    if (hour < RESPONSE_WINDOW_START || hour >= RESPONSE_WINDOW_END) {
      console.log(`[b2b制限] 時間外: hour=${hour}`);
      return;
    }
    let state = botConvoState.get(botId) || { turns: 0, dailyCount: 0, lastResetDate: getTodayDate() };
    if (state.lastResetDate !== getTodayDate()) {
      state.turns = 0;
      state.dailyCount = 0;
      state.lastResetDate = getTodayDate();
    }
    if (state.turns >= 2) {
      console.log(`[b2b制限] ターン上限: botId=${botId}, turns=${state.turns}`);
      return;
    }
    if (state.dailyCount >= 10) {
      console.log(`[b2b制限] 日次上限: botId=${botId}, dailyCount=${state.dailyCount}`);
      return;
    }
    const flags = detectFlags(message, client);
    const action = pickAction(flags);
    if (!action) return;
    try {
      await runPipeline(action, { message, flags, supabase });
    } catch (err) {
      console.error('[ボット同士応答エラー]', err);
    }
    state.turns++;
    state.dailyCount++;
    botConvoState.set(botId, state);
    console.log(`[b2b進行] botId=${botId}, turns=${state.turns}, dailyCount=${state.dailyCount}, hour=${hour}`);
    return;
  }

  // --- URLが含まれていない場合、直近URLを文脈として参照 ---
  const recent = recentUrlMap.get(channelId);
  if (recent && Date.now() - recent.timestamp < 10 * 60 * 1000) { // 10分以内
    if (/続き|詳しく|もっと|解説|再度|もう一度/.test(message.content)) {
      try {
        await message.reply('直近のURLを再チェックします…');
        const results = await deepCrawl(recent.url, userId, isAdmin);
        if (!results.length) {
          await message.reply('直近URLの再チェック結果が取得できませんでした。');
          return;
        }
        const main = results[0];
        if (!main.content || main.content.replace(/\s/g, '').length < 100) {
          await message.reply('直近URLの内容が取得できませんでした。');
          return;
        }
        const summarized = await summarizeWebPage(main.content);
        if (!summarized || /取得できません|エラー|not found|failed|unavailable/i.test(summarized)) {
          await message.reply('直近URLの内容が取得できませんでした。');
          return;
        }
        await message.reply(`【直近URL再要約】\n${summarized.slice(0, 1500)}`);
      } catch (e) {
        await message.reply('直近URLの再チェック中にエラーが発生しました。');
        console.error('[recentUrl再チェックエラー]', e);
      }
      return;
    }
    // 通常のrunPipeline等でもrecent.summaryをプロンプトに含める
    const flags = detectFlags(message, client) || {};
    (flags as any).recentUrlSummary = recent.summary;
    const action = pickAction(flags);
    if (action) await runPipeline(action, { message, flags, supabase });
  }

  // --- それ以外のメッセージは無視 ---
  return;
});

async function getExcitementScoreByAI(history: Message[]): Promise<number> {
  const prompt = `\n以下はDiscordチャンネルの直近の会話履歴です。\nこの会話が「どれくらい盛り上がっているか」を1〜10のスコアで評価してください。\n10: 非常に盛り上がっている（多人数・活発・感情的・話題性あり）\n1: ほぼ盛り上がっていない（静か・単調・反応が薄い）\nスコアのみを半角数字で返してください。\n---\n${history.slice(-20).map(m => m.author.username + ": " + m.content).join("\n")}\n---\n`;
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini-2024-07-18',
    messages: [{ role: "system", content: prompt }]
  });
  const score = parseInt(res.choices[0]?.message?.content?.match(/\d+/)?.[0] || "1", 10);
  return Math.max(1, Math.min(10, score));
}

function getCooldownMsByAI(score: number): number {
  if (score >= 9) return 20 * 1000;
  if (score >= 7) return 60 * 1000;
  if (score >= 5) return 2 * 60 * 1000;
  return 5 * 60 * 1000;
}

async function generateInterventionMessage(history: Message[]): Promise<string> {
  const prompt = `\n以下の会話の流れを踏まえ、ボットが自然に会話へ参加する一言を日本語で生成してください。\n---\n${history.slice(-10).map(m => m.author.username + ": " + m.content).join("\n")}\n---\n`;
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini-2024-07-18',
    messages: [{ role: "system", content: prompt }]
  });
  return res.choices[0]?.message?.content?.trim() || '';
}

client.on('interactionCreate', async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const chatInteraction = interaction as ChatInputCommandInteraction;
  if (chatInteraction.commandName !== 'ask') return;
  const userPrompt = chatInteraction.options.getString('prompt', true);
  await chatInteraction.deferReply();
  // build context (最小限: ユーザーID, チャンネルID, ギルドID)
  const userId = chatInteraction.user.id;
  const channelId = chatInteraction.channelId;
  const guildId = chatInteraction.guildId || '';
  // supabase, affinity, history等はrunPipeline相当で取得
  let affinity = 0;
  let history = [];
  if (supabase) {
    affinity = await getAffinity(userId, guildId);
    history = await buildHistoryContext(supabase, userId, channelId, guildId, chatInteraction.guild);
  }
  const charPrompt = buildCharacterPrompt(chatInteraction, affinity);
  // OpenAIストリーミング
  let replyMsg = await chatInteraction.fetchReply();
  let content = '';
  try {
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini-2024-07-18',
      messages: [
        { role: 'system', content: charPrompt },
        ...history,
        { role: 'user', content: userPrompt }
      ],
      stream: true,
    });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (delta) {
        content += delta;
        // 10文字ごとにedit（rate limit対策）
        if (content.length % 10 === 0) {
          await chatInteraction.editReply(content);
        }
      }
    }
    // 最終反映
    await chatInteraction.editReply(content);
    if (supabase) await updateAffinity(userId, guildId, userPrompt);
    if (supabase) await saveHistory(supabase, replyMsg, userPrompt, content, affinity);
  } catch (err) {
    await chatInteraction.editReply('エラーが発生しました。管理者にご連絡ください。');
    console.error('[ストリーミング応答エラー]', err);
  }
});

client.login(process.env.DISCORD_TOKEN);

// --- イベントループ強制維持（Railway自動停止対策） ---
setInterval(() => {}, 10000);

// --- Railwayヘルスチェック対策: ダミーHTTPサーバー ---
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('ok');
  } else {
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end('not found');
  }
}).listen(port, () => {
  console.log(`[HealthCheck] HTTPサーバー起動: ポート${port}`);
});

