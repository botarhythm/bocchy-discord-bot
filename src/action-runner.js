import dotenv from "dotenv";
dotenv.config();
import fetch from 'node-fetch';
import { OpenAI } from 'openai';
import yaml from 'js-yaml';
import fs from 'fs';
import { resolveGuildId } from './utils/resolveGuildId.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Bocchyキャラクター設定をYAMLから読み込む
const bocchyConfig = yaml.load(fs.readFileSync('bocchy-character.yaml', 'utf8'));

// ユーザーの表示名・ニックネームを正しく取得
function getUserDisplayName(message) {
  // サーバー内ならニックネーム→グローバル表示名→ユーザー名の順
  if (message.guild && message.member) {
    return message.member.displayName || message.member.user.globalName || message.member.user.username;
  }
  // DMならグローバル表示名→ユーザー名
  return message.author.globalName || message.author.username;
}

function buildCharacterPrompt(message) {
  // 必要な要素をsystem promptとして連結
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
  // ユーザー呼称を明示的に追加
  const userDisplayName = getUserDisplayName(message);
  prompt += `【ユーザー呼称】この会話の相手は「${userDisplayName}」さんです。\n`;
  prompt += `【自己紹介ルール】あなたが自分を名乗るときは必ず「ボッチー」と日本語で名乗ってください。英語表記（Bocchy）は必要なときのみ使ってください。\n`;
  return prompt;
}

// ---------- 0. 定数 ----------
const SHORT_TURNS   = 8;   // ← 直近 8 往復だけ詳細（元は4）
const MAX_ARTICLES  = 3;

// ---------- A.  summary を取ってシステムに渡すヘルパ ----------
async function buildHistoryContext(supabase, userId, channelId, guildId = null) {
  if (!supabase) return [];
  // 1) 直近詳細 n＝SHORT_TURNS（チャンネル単位）
  const { data: hist } = await supabase
    .from('conversation_histories')
    .select('messages')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .maybeSingle();
  const recent = (hist?.messages ?? []).slice(-SHORT_TURNS);

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
      .limit(1)
      .maybeSingle();
    guildRecent = (ghist?.messages ?? []).slice(-2); // 直近2往復だけ
  }

  // --- 追加: 取得状況を詳細デバッグ出力 ---
  console.log('[DEBUG:buildHistoryContext]', {
    userId,
    channelId,
    guildId,
    recent,
    sum: sum?.summary,
    guildSummary,
    guildRecent
  });
  // --- 追加: 実際にプロンプトに含まれる履歴(messages)を詳細出力 ---
  const msgs = [];
  if (guildSummary) msgs.push({ role: 'system', content: `【サーバー全体要約】${guildSummary}` });
  guildRecent.forEach(t => {
    msgs.push({ role: 'user', content: t.user });
    msgs.push({ role: 'assistant', content: t.bot });
  });
  if (sum?.summary) {
    msgs.push({ role: 'system', content: `【要約】${sum.summary}` });
  }
  recent.forEach(t => {
    msgs.push({ role: 'user', content: t.user });
    msgs.push({ role: 'assistant', content: t.bot });
  });
  // --- 追加: プロンプトに含まれる履歴を出力 ---
  console.log('[DEBUG:buildHistoryContext][PROMPT_MESSAGES]', msgs);
  return msgs;
}

// ---- 1. googleSearch: フェイルセーフ & 正規URLのみ ----
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
  return data.items
    .filter(i => /^https?:\/\//.test(i.link))
    .slice(0, MAX_ARTICLES)
    .map(i => ({ title: i.title, link: i.link, snippet: i.snippet }));
}

async function llmRespond(prompt, systemPrompt = "", message = null, history = []) {
  const charPrompt = buildCharacterPrompt(message);
  const messages = [
    { role: "system", content: charPrompt + (systemPrompt ? `\n${systemPrompt}` : "") },
    ...history
  ];
  messages.push({ role: "user", content: prompt });
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini-2024-07-18",
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
    const dd = String(now.getDate()).padStart(2, '0');
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

export async function runPipeline(action, { message, flags, supabase }) {
  try {
    // 📝 どの木陰（チャンネル）でおしゃべりしてるか見てみるね
    const channelKey = message.guild ? `${message.channel.id}` : 'DM';
    console.debug('[runPipeline] action:', action, 'user:', message.author.id, 'channel:', channelKey);
    let history = [];
    if (supabase) {
      const { data } = await supabase
        .from('conversation_histories')
        .select('messages')
        .eq('user_id', message.author.id)
        .eq('channel_id', channelKey)
        .maybeSingle();
      history = data?.messages || [];
    }

    // 直近10件の履歴をsystemPromptに追加
    let historyPrompt = '';
    if (history.length > 0) {
      const userDisplayName = getUserDisplayName(message);
      historyPrompt = '\n【会話履歴】\n' + history.slice(-10).map(h => `#${h.channel_id ? (h.channel_id === 'DM' ? 'DM' : h.channel_id) : 'DM'}\n${userDisplayName}: ${h.user}\nボッチー: ${h.bot}`).join('\n');
      console.debug('[runPipeline] 履歴プロンプト生成:', historyPrompt);
    }

    if (action === "search_only" || action === "combined") {
      const userPrompt = message.content.replace(/<@!?\\d+>/g, "").trim();
      let searchQuery = await llmRespond(userPrompt, queryGenSystemPrompt, message, []);  // 履歴混入を防止
      searchQuery = appendDateAndImpactWordsIfNeeded(userPrompt, searchQuery);
      let results = await googleSearch(searchQuery);
      if (results.length < 2) {
        // 1回だけキーワード拡張で再検索
        const altQuery = searchQuery + ' 事例 とは';
        results = results.concat(await googleSearch(altQuery));
      }
      if (results.length < 2) {
        await message.reply('🔍 検索結果が少なかったため、再検索＆AI補足を行いました。');
        const aiNote = await llmRespond(
          userPrompt + ' これを一般知識のみで150字以内で補足してください',
          '', message, []
        );
        return await message.channel.send(aiNote);
      }
      // ---- 3. LLM 要約を並列化（Promise.all） ----
      const summaries = await Promise.all(
        results.map(r => llmRespond(
          `この記事を 90 字以内で要約し末尾に URL を残してください。\n${r.title}\n${r.snippet}`,
          '', message, []))
      );
      // ---- 4. 結果フォーマットを必ず URL 付きで出力 ----
      const output = summaries
        .map((s,i)=>`### ${i+1}. ${results[i].title}\n${s}\n[リンク](${results[i].link})`)
        .join('\n\n');
      await message.reply(`【検索まとめ ${results.length}件】\n` + output);
      if (supabase) {
        await saveHistory(supabase, message, userPrompt, output);
      }
      return;
    } else if (action === "llm_only") {
      const userPrompt = message.content.replace(/<@!?\\d+>/g, "").trim();
      // DMでもサーバー全体の知識を活用するため、ユーザーが所属するサーバーIDを取得する
      let guildId = null;
      if (message.guild) {
        guildId = message.guild.id;
      } else {
        console.log('[DEBUG] DM: guild 解決開始 … userId=', message.author.id);
        guildId = await resolveGuildId(message.client, message.author.id);
        console.log('[DEBUG] DM: guildId 解決結果 =', guildId);
      }
      let historyMsgs = await buildHistoryContext(supabase, message.author.id, channelKey, guildId);
      let reply;
      if (isFeatureQuestion(userPrompt)) {
        const bocchyConfig = yaml.load(fs.readFileSync('bocchy-character.yaml', 'utf8'));
        const feature = bocchyConfig.features.find(f => f.name.includes('自己機能説明'));
        const featureDesc = feature ? feature.description : '';
        reply = await llmRespond(userPrompt, featureDesc, message, historyMsgs);
      } else {
        reply = await llmRespond(userPrompt, '', message, historyMsgs);
      }
      await message.reply(reply);
      if (supabase) {
        await saveHistory(supabase, message, userPrompt, reply);
      }
    } else {
      console.debug('[runPipeline] actionが未定義または不明:', action);
    }
  } catch (err) {
    // 🛑 もし森で迷子になったら、そっと知らせてね
    console.error('runPipelineでエラー:', err);
    try {
      await message.reply('エラーが発生しました。管理者にご連絡ください。');
    } catch (e) {}
  }
}

// 📝 おしゃべりの記録をそっと保存するよ（たくさんなら森の記憶にまとめるね）
async function saveHistory(supabase, message, userPrompt, botReply) {
  const channelId = message.guild ? message.channel.id : 'DM';
  const guildId = message.guild ? message.guild.id : null;
  // --- 追加: guildIdとmessage.guildのデバッグログ ---
  console.log('[DEBUG:saveHistory][guildIdチェック]', {
    guildId,
    'message.guild': message.guild,
    'message.guild?.id': message.guild?.id,
    'message.channel?.id': message.channel?.id,
    'message.channel?.type': message.channel?.type,
    'message.channel': message.channel,
    'message': message
  });
  // 1. チャンネル単位の保存（従来通り）
  const { data } = await supabase
    .from('conversation_histories')
    .select('id, messages')
    .eq('user_id', message.author.id)
    .eq('channel_id', channelId)
    .maybeSingle();
  let messages = data?.messages || [];
  messages.push({ user: userPrompt, bot: botReply, ts: new Date().toISOString() });
  // ✨ たくさんおしゃべりしたら、森の妖精がまとめてくれるよ
  if (messages.length >= SUMMARY_AT) {
    const summaryPrompt = messages
      .map(m => `ユーザー: ${m.user}\nBot: ${m.bot}`)
      .join('\n');
    const summary = await llmRespond(
      summaryPrompt,
      "あなたはアーカイブ要約AIです。上の対話を150文字以内で日本語要約し、重要語に 🔑 を付けてください。",
      message,
      []
    );
    // 🗂️ 森の奥にそっと要約をしまっておくね
    await supabase
      .from('conversation_summaries')
      .insert({
        user_id: message.author.id,
        channel_id: channelId,
        guild_id: guildId,
        summary,
        created_at: new Date().toISOString()
      });
    // 🧹 記憶がいっぱいになったら、ちょっとだけ整理するよ
    messages = messages.slice(-LONG_WINDOW);
  }
  // 💾 そっと保存しておくね
  if (data?.id) {
    await supabase
      .from('conversation_histories')
      .update({ messages, updated_at: new Date().toISOString() })
      .eq('id', data.id);
  } else {
    await supabase
      .from('conversation_histories')
      .insert({
        user_id: message.author.id,
        channel_id: channelId,
        guild_id: guildId,
        messages,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
  }

  // 2. サーバー全体（guild_id単位）でも保存
  if (guildId) {
    try {
      // 履歴
      const { data: gdata, error: gdataErr } = await supabase
        .from('conversation_histories')
        .select('id, messages')
        .eq('guild_id', guildId)
        .is('channel_id', null)
        .maybeSingle();
      let gmessages = gdata?.messages || [];
      gmessages.push({ user: userPrompt, bot: botReply, ts: new Date().toISOString() });
      // --- 追加: 保存前のサーバー全体履歴デバッグ ---
      console.log('[DEBUG:saveHistory][before guild save]', {
        guildId,
        gdata,
        gdataErr,
        gmessagesCount: gmessages.length,
        gmessagesPreview: gmessages.slice(-3),
      });
      let writeResult = null;
      if (gdata?.id) {
        // --- 1件あたりのメッセージ長をtruncate ---
        const MAX_MSG = 3000;
        gmessages = gmessages.map(m => ({
          ...m,
          user: m.user.slice(0, MAX_MSG),
          bot: m.bot.slice(0, MAX_MSG)
        }));
        writeResult = await supabase
          .from('conversation_histories')
          .update({ messages: gmessages, updated_at: new Date().toISOString() })
          .eq('id', gdata.id);
        console.log('[DEBUG:saveHistory][after await update]');
        // --- 追加: update時のエラーログ ---
        if (writeResult.error) {
          console.error('[DEBUG:saveHistory][guild save update ERROR]', {
            guildId,
            error: writeResult.error,
            writeResult
          });
        }
        // --- 追加: update時のwriteResult全体ログ ---
        console.log('[DEBUG:saveHistory][before update writeResult log]');
        console.log('[DEBUG:saveHistory][guild save update writeResult]', writeResult);
        console.log('[DEBUG:saveHistory][after update writeResult log]');
      } else {
        // --- 1件あたりのメッセージ長をtruncate ---
        const MAX_MSG = 3000;
        gmessages = gmessages.map(m => ({
          ...m,
          user: m.user.slice(0, MAX_MSG),
          bot: m.bot.slice(0, MAX_MSG)
        }));
        writeResult = await supabase
          .from('conversation_histories')
          .insert({
            guild_id: guildId,
            user_id: message.author.id,
            channel_id: null,
            messages: gmessages,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
        console.log('[DEBUG:saveHistory][after await insert]');
        // --- 追加: insert時のエラーログ ---
        if (writeResult.error) {
          console.error('[DEBUG:saveHistory][guild save insert ERROR]', {
            guildId,
            error: writeResult.error,
            writeResult
          });
        }
        // --- 追加: insert時のwriteResult全体ログ ---
        console.log('[DEBUG:saveHistory][before insert writeResult log]');
        console.log('[DEBUG:saveHistory][guild save insert writeResult]', writeResult);
        console.log('[DEBUG:saveHistory][after insert writeResult log]');
      }
      // --- 追加: 保存後のサーバー全体履歴デバッグ ---
      const { data: gdataAfter, error: gdataAfterErr } = await supabase
        .from('conversation_histories')
        .select('id, messages')
        .eq('guild_id', guildId)
        .is('channel_id', null)
        .is('user_id', null)
        .single(); // 1行に限定
      console.log('[DEBUG:saveHistory][after guild save]', {
        guildId,
        gdataAfter,
        gdataAfterErr,
        gmessagesCount: gdataAfter?.messages?.length,
        gmessagesPreview: gdataAfter?.messages?.slice(-3),
      });
      // サマリー
      if (gmessages.length >= SUMMARY_AT) {
        const gsummaryPrompt = gmessages
          .map(m => `ユーザー: ${m.user}\nBot: ${m.bot}`)
          .join('\n');
        const gsummary = await llmRespond(
          gsummaryPrompt,
          "あなたはアーカイブ要約AIです。上の対話を150文字以内で日本語要約し、重要語に 🔑 を付けてください。",
          message,
          []
        );
        await supabase
          .from('conversation_summaries')
          .insert({
            guild_id: guildId,
            channel_id: null,
            summary: gsummary,
            created_at: new Date().toISOString()
          });
        gmessages = gmessages.slice(-LONG_WINDOW);
        await supabase
          .from('conversation_histories')
          .update({ messages: gmessages, updated_at: new Date().toISOString() })
          .eq('guild_id', guildId)
          .is('channel_id', null);
      }
    } catch (guildSaveErr) {
      console.error('[DEBUG:saveHistory][guild save ERROR]', {
        guildId,
        guildSaveErr,
      });
    }
  }
}

export { buildHistoryContext, saveHistory };

// --- 文脈理解型 介入用AIプロンプト・関数 ---
/**
 * 直近の会話履歴から盛り上がり度・沈黙・困りごと・話題転換をAIで判定し、
 * 今ボットが自然に発言するならどんな内容が適切かを返す
 */
export async function analyzeConversationContext(historyText) {
  const prompt = `以下はDiscordチャンネルの直近の会話履歴です。\nこの場の「盛り上がり度（1-10）」「沈黙状態か」「困っている人がいるか」「話題の転換があったか」を判定してください。\nまた、今ボットが自然に発言するなら、どんな内容が適切か例を1つ出してください。\n履歴:\n${historyText}\nJSON形式で返答してください。`;
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini-2024-07-18",
    messages: [{role: "system", content: prompt}]
  });
  try {
    return JSON.parse(res.choices[0].message.content);
  } catch (e) {
    // JSONで返らなかった場合のフォールバック
    return { 盛り上がり度: 5, 沈黙: false, 困りごと: false, 話題転換: false, 介入例: res.choices[0].message.content.trim() };
  }
}

/**
 * 直近N件の履歴をテキスト化
 */
export function buildHistoryText(messages, n = 20) {
  return messages.slice(-n).map(m => `ユーザー: ${m.user}\nボッチー: ${m.bot}`).join("\n");
}

/**
 * 文脈理解型の介入判定（盛り上がり度・困りごと・沈黙などを考慮）
 * @param {Array} messages - Supabaseから取得した履歴
 * @returns {string|null} 介入例テキスト or null
 */
export async function shouldContextuallyIntervene(messages) {
  const historyText = buildHistoryText(messages, 20);
  const context = await analyzeConversationContext(historyText);
  if (context.盛り上がり度 >= 7 || context.困りごと || context.沈黙) {
    return context.介入例;
  }
  return null;
}

/**
 * 直近の会話履歴と前回介入メッセージから「話題が継続しているか」をAIで判定
 * @param {string} lastIntervention - 前回介入メッセージ
 * @param {Array} messages - 履歴（Supabase形式）
 * @returns {boolean} 継続していればtrue
 */
export async function isTopicContinued(lastIntervention, messages) {
  const historyText = buildHistoryText(messages, 10);
  const prompt = `以下はDiscordチャンネルの直近の会話履歴です。\n直前のボットの介入メッセージ:\n${lastIntervention}\nこのメッセージと同じ話題が継続していますか？「はい」または「いいえ」で答え、理由も簡単に述べてください。\n履歴:\n${historyText}`;
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini-2024-07-18",
    messages: [{role: "system", content: prompt}]
  });
  const content = res.choices[0].message.content.trim();
  return content.startsWith("はい");
} 