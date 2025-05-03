import { Client, GatewayIntentBits, Partials, ChannelType } from "discord.js";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import { detectFlags } from "./flag-detector.js";
import { pickAction } from "./decision-engine.js";
import { runPipeline, shouldContextuallyIntervene, buildHistoryContext } from "./action-runner.js";
import { initSupabase } from './services/supabaseClient.js';
import http from 'http';
import { BOT_CHAT_CHANNEL, MAX_ACTIVE_TURNS, MAX_BOT_CONVO_TURNS, MAX_DAILY_RESPONSES, RESPONSE_WINDOW_START, RESPONSE_WINDOW_END, EMERGENCY_STOP } from '../config/index.js';

dotenv.config();

process.on('unhandledRejection', (reason, p) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

if (process.env.BOT_ENABLED !== "true") {
  console.log("🚫 Bocchy bot is disabled by .env");
  process.exit(0);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
  console.log(`✅ Bocchy bot started as ${client.user.tag}`);
});

// 設定の初期化
let settings = {
  INTERVENTION_LEVEL: parseInt(process.env.INTERVENTION_LEVEL) || 2,
  INTERVENTION_QUERIES: process.env.INTERVENTION_QUERIES
    ? process.env.INTERVENTION_QUERIES.split(',').map(q => q.trim())
    : ["ニュース", "最新"]
};

// Supabaseクライアントを初期化するよ（settingsを渡すことで設定購読が動作するよ）
let supabase = initSupabase(settings);

function isInterventionQuery(message) {
  return settings.INTERVENTION_QUERIES.some(q => message.content.includes(q));
}

function shouldIntervene(message) {
  // DMまたは@メンション時は必ず返答
  if (!message.guild) return true;
  if (isExplicitMention(message)) return true;
  if (isInterventionQuery(message)) return true;
  if (settings.INTERVENTION_LEVEL <= 0) return false;
  if (settings.INTERVENTION_LEVEL >= 10) return true;
  return Math.random() < settings.INTERVENTION_LEVEL / 10;
}

function logMetric(metricName, value) {
  console.log(`[メトリクス] ${metricName}: ${value}`);
}

// JST現在時刻取得ヘルパー
function getNowJST() {
  return new Date(new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }));
}

// 時間帯ごとの日本語挨拶
function greetingJp(date) {
  const h = date.getHours();
  if (h < 4) return 'こんばんは';
  if (h < 11) return 'おはようございます';
  if (h < 18) return 'こんにちは';
  return 'こんばんは';
}

function isExplicitMention(message) {
  // メンションまたは「ボッチー」という名前が含まれる場合
  if (message.mentions.has(client.user)) return true;
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

/** 日本時間の今日の日付文字列(YYYY/MM/DD)を返す */
function getTodayDate() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[0];
}

client.on("messageCreate", async (message) => {
  const isBot = message.author.bot;
  const isHuman = !isBot;
  const botId = message.author.id;
  const channelId = message.channel?.id;

  // --- 人間の発言には必ず応答（BOT_CHAT_CHANNEL含む） ---
  if (isHuman) {
    // 通常のrunPipeline処理
    const flags = detectFlags(message, client);
    const action = pickAction(flags);
    try {
      await runPipeline(action, { message, flags, supabase });
    } catch (err) {
      console.error('[人間応答エラー]', err);
      await message.reply('エラーが発生しました。管理者にご連絡ください。');
    }
    // 介入時は全ボットのカウントをリセット
    botConvoState.clear();
    return;
  }

  // --- ボット同士会話制御（BOT_CHAT_CHANNEL限定） ---
  if (isBot && channelId === BOT_CHAT_CHANNEL && botId !== client.user.id) {
    let state = botConvoState.get(botId) || { turns: 0, dailyCount: 0, lastResetDate: getTodayDate() };
    // 日付が変わったらリセット
    if (state.lastResetDate !== getTodayDate()) {
      state.turns = 0;
      state.dailyCount = 0;
      state.lastResetDate = getTodayDate();
    }
    if (state.turns >= MAX_BOT_CONVO_TURNS || state.dailyCount >= MAX_DAILY_RESPONSES) return;
    // 通常のrunPipeline処理
    const flags = detectFlags(message, client);
    const action = pickAction(flags);
    try {
      await runPipeline(action, { message, flags, supabase });
    } catch (err) {
      console.error('[ボット同士応答エラー]', err);
    }
    state.turns++;
    state.dailyCount++;
    botConvoState.set(botId, state);
    return;
  }

  // --- それ以外のメッセージは無視 ---
  return;
});

async function getExcitementScoreByAI(history) {
  const prompt = `\n以下はDiscordチャンネルの直近の会話履歴です。\nこの会話が「どれくらい盛り上がっているか」を1〜10のスコアで評価してください。\n10: 非常に盛り上がっている（多人数・活発・感情的・話題性あり）\n1: ほぼ盛り上がっていない（静か・単調・反応が薄い）\nスコアのみを半角数字で返してください。\n---\n${history.slice(-20).map(m => m.author.username + ": " + m.content).join("\n")}\n---\n`;
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini-2024-07-18",
    messages: [{ role: "system", content: prompt }]
  });
  const score = parseInt(res.choices[0].message.content.match(/\d+/)?.[0] || "1", 10);
  return Math.max(1, Math.min(10, score));
}

function getCooldownMsByAI(score) {
  if (score >= 9) return 20 * 1000;
  if (score >= 7) return 60 * 1000;
  if (score >= 5) return 2 * 60 * 1000;
  return 5 * 60 * 1000;
}

async function generateInterventionMessage(history) {
  const prompt = `\n以下の会話の流れを踏まえ、ボットが自然に会話へ参加する一言を日本語で生成してください。\n---\n${history.slice(-10).map(m => m.author.username + ": " + m.content).join("\n")}\n---\n`;
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini-2024-07-18",
    messages: [{ role: "system", content: prompt }]
  });
  return res.choices[0].message.content.trim();
}

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
