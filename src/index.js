import { Client, GatewayIntentBits, Partials, ChannelType } from "discord.js";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import { detectFlags } from "./flag-detector.js";
import { pickAction } from "./decision-engine.js";
import { runPipeline } from "./action-runner.js";
import { createClient } from '@supabase/supabase-js';

dotenv.config();

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
    GatewayIntentBits.DirectMessages
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

// Supabase連携（接続情報があれば有効化）
let supabase = null;
const SUPABASE_AUTO_MIGRATION = process.env.SUPABASE_AUTO_MIGRATION !== 'false';
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY && SUPABASE_AUTO_MIGRATION) {
  try {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    supabase
      .channel('custom-all-channel')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'bot_settings' },
        payload => {
          const { key, value } = payload.new;
          if (key === 'INTERVENTION_QUERIES') {
            settings.INTERVENTION_QUERIES = value.split(',').map(q => q.trim());
          } else if (key === 'INTERVENTION_LEVEL') {
            settings.INTERVENTION_LEVEL = parseInt(value) || settings.INTERVENTION_LEVEL;
          } else {
            settings[key] = value;
          }
          console.log(`Supabase設定が更新されました: ${key} = ${value}`);
        }
      )
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          console.log('Supabase連携が有効です');
        }
      });
  } catch (e) {
    console.warn('Supabase連携に失敗しました。環境変数のみで動作します。', e);
  }
} else {
  console.log('Supabase連携なし。環境変数のみで動作します。');
}

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

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const channelId = message.channel.id;
  if (!channelHistories.has(channelId)) channelHistories.set(channelId, []);
  const history = channelHistories.get(channelId);
  history.push(message);
  if (history.length > 30) history.shift();

  // AIで盛り上がり度を判定
  const excitementScore = await getExcitementScoreByAI(history);

  // スコアに応じてクールダウン
  const now = Date.now();
  const last = interventionCooldowns.get(channelId) || 0;
  const cooldownMs = getCooldownMsByAI(excitementScore);
  if (now - last < cooldownMs) return;

  // 盛り上がり度が高いときだけ介入
  if (excitementScore >= 7) {
    const intervention = await generateInterventionMessage(history);
    await message.channel.send(intervention);
    interventionCooldowns.set(channelId, now);
  }
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
