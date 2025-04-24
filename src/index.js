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

client.on("messageCreate", async (message) => {
  console.debug('[messageCreate] メッセージ受信:', message.content);
  if (message.author.bot) return;

  const flags = detectFlags(message, client);
  const action = pickAction(flags);
  console.log("flags:", flags, "action:", action);
  if (action === "llm_only") {
    if (!isExplicitMention(message) && !shouldIntervene(message)) {
      logMetric('intervention_per_msg', 0);
      return;
    }
    logMetric('intervention_per_msg', 1);
  }
  if (action) {
    await runPipeline(action, { message, flags, supabase });
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
