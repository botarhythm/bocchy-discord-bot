import { Client, GatewayIntentBits, Partials, ChannelType } from "discord.js";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import { detectFlags } from "./flag-detector.js";
import { pickAction } from "./decision-engine.js";
import { runPipeline, shouldContextuallyIntervene, buildHistoryContext } from "./action-runner.js";
import { createClient } from '@supabase/supabase-js';
import http from 'http';
import { BOT_CHAT_CHANNEL, MAX_ACTIVE_TURNS, MAX_BOT_CONVO_TURNS, MAX_DAILY_RESPONSES, RESPONSE_WINDOW_START, RESPONSE_WINDOW_END } from '../config/index.js';

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

// --- まとめ要望時のみ会話まとめを出力するロジック ---

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

// --- 追加: 介入後の積極応答モード管理 ---
const activeConversationMap = new Map(); // channelId => { turns: number, lastUserId: string|null }

// --- ボット同士会話モード設定 ---
let botConvoCounts = new Map(); // channelId → bot会話ターン数
let botConvoTimers = new Map();
let dailyResponses = 0;
let dailyResetDate = getTodayDate();

/** 日本時間の今日の日付文字列(YYYY/MM/DD)を返す */
function getTodayDate() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).split(' ')[0];
}

client.on("messageCreate", async (message) => {
  // --- 追加: 受信メッセージの詳細デバッグログ ---
  console.log('[DEBUG:messageCreate] content:', message.content, '\n  channelId:', message.channel?.id, '\n  guildId:', message.guild?.id, '\n  channelType:', message.channel?.type, '\n  username:', message.author?.username, '\n  isDM:', !message.guild, '\n  message.guild:', message.guild, '\n  message.channel.type:', message.channel?.type);
  if (message.author.bot) return;
  // 日次リセット
  const today = getTodayDate();
  if (today !== dailyResetDate) {
    dailyResetDate = today;
    dailyResponses = 0;
  }
  // 時間帯制限
  const hour = getNowJST().getHours();
  if (hour < RESPONSE_WINDOW_START || hour >= RESPONSE_WINDOW_END) return;
  const isDM = !message.guild;
  const channelId = message.channel?.id;
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
    // --- 追加: 介入後の積極応答モード判定 ---
    if (!isDM && channelId && activeConversationMap.has(channelId)) {
      const state = activeConversationMap.get(channelId);
      // ユーザーがボットの直前の返答に返事した場合はターン数リセット
      if (state.lastUserId && message.author.id === state.lastUserId) {
        state.turns = 0;
        activeConversationMap.set(channelId, state);
      } else {
        state.turns++;
        activeConversationMap.set(channelId, state);
      }
      // Nターン以内なら必ず返事（runPipelineで返答）
      if (state.turns < MAX_ACTIVE_TURNS) {
        const flags = detectFlags(message, client);
        const action = pickAction(flags);
        try {
          await runPipeline(action, { message, flags, supabase });
        } catch (err) {
          console.error('[積極応答モードエラー]', err);
        }
        // 最後に返答したユーザーを記録
        state.lastUserId = message.author.id;
        activeConversationMap.set(channelId, state);
        return;
      } else {
        // 一定ターン経過で積極応答モード解除
        activeConversationMap.delete(channelId);
      }
    }
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
          console.log('[強制介入デバッグ] runPipeline実行: action=', action, 'flags=', flags);
          // --- 追加: 自然介入後の積極応答モード開始 ---
          activeConversationMap.set(channelId, { turns: 0, lastUserId: message.author.id });
        } catch (err) {
          debugInfo.error = err?.stack || err?.message || String(err);
          console.error('[強制介入デバッグ] runPipelineエラー:', debugInfo);
        }
        return;
      }
    }
    // --- 文脈理解型の自然介入（新ロジック） ---
    if (!isDM && supabase) {
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
      if (messages.length > 5) {
        const intervention = await shouldContextuallyIntervene(messages, lastIntervention);
        if (intervention) {
          await message.channel.send(intervention);
          lastInterventions.set(channelId, intervention);
          interventionCooldowns.set(channelId, Date.now());
          // --- 追加: 介入後は積極応答モードON ---
          activeConversationMap.set(channelId, { turns: 0, lastUserId: message.author.id });
          return;
        }
      }
    }
    // --- 既存の盛り上がり判定（自然介入/fallback） ---
    if (!isDM) {
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
    // --- 会話まとめ要求 ---
    if (supabase && /まとめ|要約/.test(message.content)) {
      const channelKey = message.guild ? message.channel.id : 'DM';
      // 最新のまとめを取得
      const { data: sumData } = await supabase
        .from('conversation_summaries')
        .select('summary')
        .eq('user_id', message.author.id)
        .eq('channel_id', channelKey)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (sumData?.summary) {
        await message.reply(`🔖 会話のまとめ:
${sumData.summary}`);
      } else {
        await message.reply('まだまとめできるほどの会話履歴がありません。');
      }
      return;
    }
    // ボット同士応答（チャンネル固定）
    if (channelId === BOT_CHAT_CHANNEL && message.author.bot) {
      // 日次上限チェック
      if (dailyResponses >= MAX_DAILY_RESPONSES) return;
      // ターン数制限
      const turns = botConvoCounts.get(channelId) || 0;
      if (turns >= MAX_BOT_CONVO_TURNS) return;
      botConvoCounts.set(channelId, turns + 1);
      // 応答実行
      const flags = detectFlags(message, client);
      const action = pickAction(flags);
      await runPipeline(action, { message, flags, supabase });
      dailyResponses++;
      return;
    }
    // 会話に人間が介入したらリセット
    if (channelId === BOT_CHAT_CHANNEL && !message.author.bot) {
      botConvoCounts.delete(channelId);
      if (botConvoTimers.has(channelId)) {
        clearTimeout(botConvoTimers.get(channelId));
        botConvoTimers.delete(channelId);
      }
      // 一定時間後にリセット
      const tid = setTimeout(() => botConvoCounts.delete(channelId), 10 * 60 * 1000);
      botConvoTimers.set(channelId, tid);
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
