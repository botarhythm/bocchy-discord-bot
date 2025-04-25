import { Client, GatewayIntentBits, Partials, ChannelType } from "discord.js";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import { detectFlags } from "./flag-detector.js";
import { pickAction } from "./decision-engine.js";
import { runPipeline, shouldContextuallyIntervene, buildHistoryContext } from "./action-runner.js";
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
// 直前の介入メッセージをチャンネルごとに記録
const lastInterventions = new Map();

client.on("messageCreate", async (message) => {
  // --- 追加: 受信メッセージの詳細デバッグログ ---
  console.log('[DEBUG:messageCreate] content:', message.content, '\n  channelId:', message.channel?.id, '\n  guildId:', message.guild?.id, '\n  channelType:', message.channel?.type, '\n  username:', message.author?.username, '\n  isDM:', !message.guild, '\n  message.guild:', message.guild, '\n  message.channel.type:', message.channel?.type);
  if (message.author.bot) return;
  const isDM = !message.guild;
  let debugInfo = {
    timestamp: new Date().toISOString(),
    userId: message.author.id,
    username: message.author.username,
    isDM,
    content: message.content,
    supabase: !!supabase,
    openaiKey: !!process.env.OPENAI_API_KEY,
    action: null,
    flags: null,
    error: null
  };
  try {
    // --- サーバーチャンネルの強制介入判定 ---
    if (!isDM) {
      if (shouldIntervene(message)) {
        console.log(`[強制介入デバッグ] shouldIntervene=true: メッセージ: ${message.content}`);
        const flags = detectFlags(message, client);
        debugInfo.flags = flags;
        const action = pickAction(flags);
        debugInfo.action = action;
        try {
          await runPipeline(action, { message, flags, supabase });
          // 介入メッセージを記録（強制介入時はrunPipeline内でreply/sendされる）
          // ここでは記録しない（自然介入のみ記録）
          console.log('[強制介入デバッグ] runPipeline実行: action=', action, 'flags=', flags);
        } catch (err) {
          debugInfo.error = err?.stack || err?.message || String(err);
          console.error('[強制介入デバッグ] runPipelineエラー:', debugInfo);
        }
        return;
      }
    }
    // --- 文脈理解型の自然介入（新ロジック） ---
    if (!isDM && supabase) {
      const channelId = message.channel.id;
      // Supabaseから履歴を取得
      const { data } = await supabase
        .from('conversation_histories')
        .select('messages')
        .eq('channel_id', channelId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const messages = data?.messages || [];
      // 直前の介入メッセージを取得
      const lastIntervention = lastInterventions.get(channelId) || null;
      if (messages.length > 5) { // 履歴がある程度溜まってから
        const intervention = await shouldContextuallyIntervene(messages, lastIntervention);
        if (intervention) {
          await message.channel.send(intervention);
          // 介入メッセージを記録
          lastInterventions.set(channelId, intervention);
          // クールダウン管理は既存のinterventionCooldownsでOK
          interventionCooldowns.set(channelId, Date.now());
          return;
        }
      }
    }
    // --- 既存の盛り上がり判定（自然介入/fallback） ---
    if (!isDM) {
      const channelId = message.channel.id;
      if (!channelHistories.has(channelId)) channelHistories.set(channelId, []);
      const history = channelHistories.get(channelId);
      history.push(message);
      if (history.length > 30) history.shift();
      const excitementScore = await getExcitementScoreByAI(history);
      console.log(`[自然介入デバッグ] チャンネルID: ${channelId}, 盛り上がりスコア: ${excitementScore}`);
      const now = Date.now();
      const last = interventionCooldowns.get(channelId) || 0;
      const cooldownMs = getCooldownMsByAI(excitementScore);
      if (now - last < cooldownMs) {
        console.log(`[自然介入デバッグ] クールダウン中: 残り${((cooldownMs - (now - last))/1000).toFixed(1)}秒`);
        return;
      }
      if (excitementScore >= 7) {
        const intervention = await generateInterventionMessage(history);
        console.log(`[自然介入デバッグ] 介入メッセージ送信: ${intervention}`);
        await message.channel.send(intervention);
        interventionCooldowns.set(channelId, now);
      } else {
        console.log(`[自然介入デバッグ] 介入せず（スコア${excitementScore} < 7）`);
      }
      return;
    }
    // --- DMまたは通常処理 ---
    const flags = detectFlags(message, client);
    debugInfo.flags = flags;
    const action = pickAction(flags);
    debugInfo.action = action;
    if (isDM) {
      try {
        await runPipeline(action, { message, flags, supabase });
        console.log('[DMデバッグ情報]', debugInfo);
      } catch (err) {
        debugInfo.error = err?.stack || err?.message || String(err);
        console.error('[DM自動デバッグエラー]', debugInfo);
        await message.reply('エラーが発生しました。管理者にご連絡ください。');
      }
      return;
    }
  } catch (e) {
    debugInfo.error = e?.stack || e?.message || String(e);
    if (isDM) {
      await message.reply('エラーが発生しました。管理者にご連絡ください。');
    }
    console.error('自動デバッグ全体エラー:', debugInfo);
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
