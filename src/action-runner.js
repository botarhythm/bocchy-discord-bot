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
  prompt += `【自己紹介ルール】あなたが自分を名乗るときは必ず「ボッチー」と日本語で名乗ってください。英語表記（Bocchy）は必要なときのみ使ってください。\n`;
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
async function buildHistoryContext(supabase, userId, channelId, guildId = null, guild = null) {
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
    guildRecent = (ghist?.messages ?? []).slice(-2); // 直近2往復だけ
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

  // 5) ベクトル類似検索でパーソナライズ履歴取得
  let personalizedHistory = [];
  try {
    // 最新発言をベクトル化
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
        p_match_count: 3
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

  // 7) 参加者情報の取得
  let memberNames = [];
  if (guild) {
    try {
      memberNames = await getGuildMemberNames(guild, 20);
    } catch (e) { memberNames = []; }
  }

  // 8) ユーザー相関関係サマリーの生成
  let correlationSummary = '';
  try {
    // ユーザー間のやり取り頻度・共通話題を簡易集計
    const userPairCounts = {};
    const topicCounts = {};
    for (let i = 0; i < guildAllMessages.length - 1; i++) {
      const m1 = guildAllMessages[i];
      const m2 = guildAllMessages[i+1];
      if (m1.user && m2.user) {
        const pair = `${m1.user}↔${m2.user}`;
        userPairCounts[pair] = (userPairCounts[pair] || 0) + 1;
      }
      // 話題抽出（単純にキーワード頻度で）
      const words = (m1.user + ' ' + m1.bot).split(/\s+/);
      for (const w of words) {
        if (w.length > 1) topicCounts[w] = (topicCounts[w] || 0) + 1;
      }
    }
    // 上位のやり取りペア
    const topPairs = Object.entries(userPairCounts)
      .sort((a,b) => b[1]-a[1])
      .slice(0,5)
      .map(([pair, count]) => `・${pair}（${count}回）`)
      .join('\n');
    // 上位の話題
    const topTopics = Object.entries(topicCounts)
      .sort((a,b) => b[1]-a[1])
      .slice(0,5)
      .map(([topic, count]) => `#${topic}（${count}回）`)
      .join(' ');
    correlationSummary = `【サーバー内ユーザー相関サマリー】\n${topPairs}\n【共通話題】${topTopics}`;
  } catch (e) { correlationSummary = ''; }

  // --- 取得状況を詳細デバッグ出力 ---
  console.log('[DEBUG:buildHistoryContext]', {
    userId,
    channelId,
    guildId,
    recent,
    sum: sum?.summary,
    guildSummary,
    guildRecent,
    userProfile,
    personalizedHistory,
    globalContext,
    memberNames,
    correlationSummary
  });
  // --- 実際にプロンプトに含まれる履歴(messages)を詳細出力 ---
  const msgs = [];
  if (userProfile) {
    msgs.push({ role: 'system', content: `【ユーザープロファイル】${JSON.stringify(userProfile.preferences || {})}` });
  }
  if (globalContext) {
    msgs.push({ role: 'system', content: `【会話全体要約】${globalContext.summary}` });
    msgs.push({ role: 'system', content: `【主な話題】${(globalContext.topics||[]).join('、')}` });
    msgs.push({ role: 'system', content: `【全体トーン】${globalContext.tone}` });
  }
  if (guildSummary) msgs.push({ role: 'system', content: `【サーバー全体要約】${guildSummary}` });
  if (memberNames.length > 0) {
    msgs.push({ role: 'system', content: `【現在の参加者】${memberNames.join('、')}` });
  }
  if (correlationSummary) {
    msgs.push({ role: 'system', content: correlationSummary });
  }
  guildRecent.forEach(t => {
    msgs.push({ role: 'user', content: t.user });
    msgs.push({ role: 'assistant', content: t.bot });
  });
  if (sum?.summary) {
    msgs.push({ role: 'system', content: `【要約】${sum.summary}` });
  }
  personalizedHistory.forEach(t => {
    msgs.push({ role: 'user', content: t.user });
    msgs.push({ role: 'assistant', content: t.bot });
  });
  recent.forEach(t => {
    msgs.push({ role: 'user', content: t.user });
    msgs.push({ role: 'assistant', content: t.bot });
  });
  // --- プロンプトに含まれる履歴を出力 ---
  console.log('[DEBUG:buildHistoryContext][PROMPT_MESSAGES]', msgs);
  return msgs;
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

// ---- 新: ChatGPT風・自然なWeb検索体験 ----
async function enhancedSearch(userPrompt, message, affinity, supabase) {
  // 1) 検索クエリ生成
  let searchQuery = await llmRespond(userPrompt, queryGenSystemPrompt, message, [], buildCharacterPrompt(message, affinity));
  searchQuery = appendDateAndImpactWordsIfNeeded(userPrompt, searchQuery);
  // 2) 検索実行
  let results = await googleSearch(searchQuery);
  if (results.length < 2) {
    const altQuery = searchQuery + ' 事例 とは';
    results = results.concat(await googleSearch(altQuery));
  }
  // 3) ページ取得＆テキスト抽出 or スニペット利用
  let pageContents = await Promise.all(
    results.map(async r => {
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
  // 5) ChatGPT風の回答テンプレート
  if (pageContents.length === 0 || pageContents.every(pg => !pg.text.trim())) {
    // 検索で見つからなかった場合、LLMで一般知識・推論回答を生成
    const fallbackPrompt = `Web検索では直接的な情報が見つかりませんでしたが、一般的な知識や推論でお答えします。\n\n質問: ${userPrompt}`;
    const fallbackAnswer = await llmRespond(userPrompt, fallbackPrompt, message, [], buildCharacterPrompt(message, affinity));
    return { answer: fallbackAnswer, results: [] };
  }
  const docs = pageContents.map((pg,i) => `【${i+1}】${pg.title}\n${pg.text}\nURL: ${pg.link}`).join('\n\n');
  const urlList = pageContents.map((pg,i) => `【${i+1}】${pg.title}\n${pg.link}`).join('\n');
  const systemPrompt =
    `あなたはWeb検索アシスタントです。以下の検索結果を参考に、ユーザーの質問「${userPrompt}」に日本語で分かりやすく回答してください。` +
    `\n\n【検索結果要約】\n${docs}\n\n【参考URLリスト】\n${urlList}\n\n` +
    `・信頼できる情報源を優先し、事実ベースで簡潔にまとめてください。\n・必要に応じて参考URLを文中で引用してください。`;
  let answer = await llmRespond(userPrompt, systemPrompt, message, [], buildCharacterPrompt(message, affinity));
  answer += `\n\n【出典URL】\n` + pageContents.map((pg,i) => `【${i+1}】${pg.link}`).join('\n');
  if (supabase) await saveHistory(supabase, message, `[検索クエリ] ${searchQuery}`, docs, affinity);
  return { answer, results: pageContents };
}

// サーバーメンバー名リスト取得関数
async function getGuildMemberNames(guild, max = 20) {
  await guild.members.fetch(); // キャッシュに全員をロード
  const members = Array.from(guild.members.cache.values())
    .slice(0, max)
    .map(m => {
      const name = m.displayName || m.user.globalName || m.user.username;
      return m.user.bot ? `${name}（Bot）` : name;
    });
  return members;
}

export async function runPipeline(action, { message, flags, supabase }) {
  const guildId = message.guild?.id || 'DM';
  const affinity = supabase
      ? await getAffinity(supabase, message.author.id, guildId)
      : 0;
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

    // --- サーバーメンバー名リストアップ質問の判定（最優先） ---
    const memberListPatterns = [
      /サーバー(の|にいる)?メンバー(を|教えて|一覧|だれ|誰|list|list up|リスト|名前|ネーム)/i,
      /このチャンネル(の|にいる)?メンバー(を|教えて|一覧|だれ|誰|list|list up|リスト|名前|ネーム)/i,
      /メンバー(一覧|リスト|だれ|誰|教えて|名前|ネーム)/i,
      /ログインしている(人|メンバー|ユーザー|ユーザ|名前|ネーム)/i,
      /参加している(人|メンバー|ユーザー|ユーザ|名前|ネーム)/i,
      /いる(人|メンバー|ユーザー|ユーザ|名前|ネーム)/i,
      /オンライン(の)?(人|メンバー|ユーザー|ユーザ|名前|ネーム)/i,
      /active( user| member| name| list)?/i,
      /在籍(している)?(人|メンバー|ユーザー|ユーザ|名前|ネーム)/i,
      /connected( user| member| name| list)?/i,
      /who (is|are) (in|on|logged in|online|connected to) (this )?(server|guild|channel)/i
    ];
    const userPrompt = message.content.replace(/<@!?\\d+>/g, "").trim();
    if (message.guild && memberListPatterns.some(re => re.test(userPrompt))) {
      const names = await getGuildMemberNames(message.guild, 20);
      let reply = '';
      if (names.length === 0) {
        reply = 'このサーバーにはまだメンバーがいません。';
      } else {
        reply = `このサーバーの主なメンバーは：\n${names.map(n => `・${n}`).join('\n')}`;
        if (message.guild.memberCount > names.length) {
          reply += `\n他にも${message.guild.memberCount - names.length}名が在籍しています。`;
        }
      }
      await message.reply(reply);
      if (supabase) await saveHistory(supabase, message, userPrompt, reply, 0);
      return;
    }

    if (action === "search_only") {
      // high-precision search with LLM
      const { answer, results } = await enhancedSearch(userPrompt, message, affinity, supabase);
      await message.reply(answer);
      if (supabase) await saveHistory(supabase, message, userPrompt, answer, affinity);
      return;
    } else if (action === "combined") {
      // --- ここから分岐ロジック追加 ---
      // 1. 検索依頼ワード・時事性ワードの簡易判定
      const searchWords = [
        /調べて|検索して|検索|webで|ウェブで|ニュース|最新|天気|速報|イベント|開催|今日|昨日|明日|今年|今年度|今年の|今年の|今年度の|今年度|\d{4}年/,
      ];
      const needsSearch = searchWords.some(re => re.test(userPrompt));
      let doSearch = needsSearch;
      // 2. 曖昧な場合はLLMで判定
      if (!needsSearch) {
        const judgePrompt = `ユーザーの質問:「${userPrompt}」\nこの質問はWeb検索（Google検索など）を使わないと正確に答えられない内容ですか？\n「はい」または「いいえ」だけで答えてください。`;
        const judge = await llmRespond(userPrompt, judgePrompt, message, [], buildCharacterPrompt(message, affinity));
        doSearch = judge.trim().startsWith('はい');
      }
      if (doSearch) {
        const { answer } = await enhancedSearch(userPrompt, message, affinity, supabase);
        await message.reply(answer);
        return;
      }
      // --- ここから介入判定ロジック ---
      // 介入判定（明示トリガー/AI/確率）
      let guildId = message.guild ? message.guild.id : await resolveGuildId(message.client, message.author.id);
      let channelId = message.guild ? message.channel.id : 'DM';
      let historyMsgs = await buildHistoryContext(supabase, message.author.id, channelId, guildId, message.guild);
      // 直近の介入メッセージ取得（例: 最後のbot発言）
      const lastIntervention = historyMsgs.reverse().find(m => m.role === 'assistant')?.content || null;
      // AI介入判定
      let aiInterventionResult = null;
      try {
        aiInterventionResult = await shouldInterveneWithContinuation(historyMsgs, lastIntervention);
      } catch (e) {
        aiInterventionResult = { intervene: false, reason: 'AI判定失敗', example: '' };
      }
      // 厳格な介入判定
      const intervene = shouldInterveneStrict(message, { aiInterventionResult });
      // ログ出力
      console.log('[INTERVENTION_DECISION]', { intervene, aiInterventionResult });
      if (intervene) {
        // 介入時は会話フォロー用プロンプトを構築
        const contextMsgs = await buildContextForFollowup(supabase, message.author.id, channelId, guildId, message.guild);
        // Token消費監視
        const totalTokens = contextMsgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        console.log('[INTERVENTION_CONTEXT]', { totalTokens, contextMsgs });
        // 介入例がAI判定で得られればそれを使う
        let reply = aiInterventionResult.example || 'こんにちは、ボッチーです。何かお困りですか？';
        // LLMで最終調整
        reply = await llmRespond(userPrompt, '', message, contextMsgs, buildCharacterPrompt(message, affinity));
        await message.reply({ content: reply, allowedMentions: { repliedUser: false } });
        if (supabase) await saveHistory(supabase, message, userPrompt, reply, affinity);
        return;
      }
      // --- 通常のLLM応答 ---
      let userProfile = null, globalContext = null;
      for (const m of historyMsgs) {
        if (m.role === 'system' && m.content.startsWith('【ユーザープロファイル】')) {
          try { userProfile = JSON.parse(m.content.replace('【ユーザープロファイル】','').trim()); } catch(e){}
        }
        if (m.role === 'system' && m.content.startsWith('【会話全体要約】')) {
          globalContext = globalContext || {};
          globalContext.summary = m.content.replace('【会話全体要約】','').trim();
        }
        if (m.role === 'system' && m.content.startsWith('【主な話題】')) {
          globalContext = globalContext || {};
          globalContext.topics = m.content.replace('【主な話題】','').split('、').map(s=>s.trim()).filter(Boolean);
        }
        if (m.role === 'system' && m.content.startsWith('【全体トーン】')) {
          globalContext = globalContext || {};
          globalContext.tone = m.content.replace('【全体トーン】','').trim();
        }
      }
      let reply = await llmRespond(userPrompt, '', message, historyMsgs, buildCharacterPrompt(message, affinity, userProfile, globalContext));
      await message.reply({ content: reply, allowedMentions: { repliedUser: false } });
      if (supabase) await saveHistory(supabase, message, userPrompt, reply, affinity);
      return;
    } else if (action === "llm_only") {
      const userPrompt = message.content.replace(/<@!?\\d+>/g, "").trim();
      let guildId = null;
      if (message.guild) {
        guildId = message.guild.id;
      } else {
        console.log('[DEBUG] DM: guild 解決開始 … userId=', message.author.id);
        guildId = await resolveGuildId(message.client, message.author.id);
        console.log('[DEBUG] DM: guildId 解決結果 =', guildId);
      }
      let historyMsgs = await buildHistoryContext(supabase, message.author.id, channelKey, guildId, message.guild);
      let userProfile = null, globalContext = null;
      for (const m of historyMsgs) {
        if (m.role === 'system' && m.content.startsWith('【ユーザープロファイル】')) {
          try { userProfile = JSON.parse(m.content.replace('【ユーザープロファイル】','').trim()); } catch(e){}
        }
        if (m.role === 'system' && m.content.startsWith('【会話全体要約】')) {
          globalContext = globalContext || {};
          globalContext.summary = m.content.replace('【会話全体要約】','').trim();
        }
        if (m.role === 'system' && m.content.startsWith('【主な話題】')) {
          globalContext = globalContext || {};
          globalContext.topics = m.content.replace('【主な話題】','').split('、').map(s=>s.trim()).filter(Boolean);
        }
        if (m.role === 'system' && m.content.startsWith('【全体トーン】')) {
          globalContext = globalContext || {};
          globalContext.tone = m.content.replace('【全体トーン】','').trim();
        }
      }
      let reply;
      if (isFeatureQuestion(userPrompt)) {
        const bocchyConfig = yaml.load(fs.readFileSync('bocchy-character.yaml', 'utf8'));
        const feature = bocchyConfig.features.find(f => f.name.includes('自己機能説明'));
        const featureDesc = feature ? feature.description : '';
        reply = await llmRespond(userPrompt, featureDesc, message, historyMsgs, buildCharacterPrompt(message, affinity, userProfile, globalContext));
      } else {
        reply = await llmRespond(userPrompt, '', message, historyMsgs, buildCharacterPrompt(message, affinity, userProfile, globalContext));
      }
      // --- 感情分析 ---
      const sentiment = await getSentiment(userPrompt); // ← DB保存等の分析用途のみ
      // --- 自己反省チェック ---
      const reflection = await reflectiveCheck(userPrompt, reply);
      if (!reflection.ok && reflection.suggestion) {
        reply = reflection.suggestion;
      }
      await message.reply({ content: reply, allowedMentions: { repliedUser: false } });
      if (supabase) {
        await saveHistory(supabase, message, userPrompt, reply, affinity);
        // --- user_interactionsテーブルにも保存（パーソナライズ/埋め込み/感情） ---
        try {
          const embRes = await openai.embeddings.create({
            model: 'text-embedding-ada-002',
            input: userPrompt
          });
          const embedding = embRes.data[0].embedding;
          await supabase.from('user_interactions').insert({
            user_id: message.author.id,
            guild_id: guildId,
            message: userPrompt,
            bot_reply: reply,
            embedding,
            sentiment
          });
        } catch(e) { console.error('[user_interactions保存失敗]', e); }
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
async function saveHistory(supabase, message, userPrompt, botReply, affinity) {
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
      [], buildCharacterPrompt(message, affinity));
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
          [], buildCharacterPrompt(message, affinity));
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

// Export core functions including prompts and response
export { buildHistoryContext, saveHistory, buildCharacterPrompt, llmRespond };

// --- 文脈理解型 介入用AIプロンプト・関数 ---
/**
 * 直近の会話履歴と前回介入メッセージから、
 * - 介入すべきか（盛り上がり度・困りごと・沈黙）
 * - 介入後の会話継続判定
 * - 介入例生成
 * を一括でAI判定し、Token消費を最小化
 * @param {Array} messages - Supabaseから取得した履歴
 * @param {string|null} lastIntervention - 直前のボット介入メッセージ（なければnull）
 * @returns {Object} { intervene: boolean, continued: boolean, reason: string, example: string }
 */
export async function shouldInterveneWithContinuation(messages, lastIntervention = null) {
  const historyText = buildHistoryText(messages, 20);
  const prompt = `以下はDiscordチャンネルの直近の会話履歴です。\n` +
    (lastIntervention ? `直前のボットの介入メッセージ:\n${lastIntervention}\n` : '') +
    `この場の「盛り上がり度（1-10）」「沈黙状態か」「困っている人がいるか」「話題の転換があったか」を判定してください。\n` +
    `また、直前のボット介入があれば「その話題が継続しているか」も判定してください。\n` +
    `今ボットが自然に発言するなら、どんな内容が適切か例を1つ出してください。\n` +
    `JSON形式で以下のキーで返答してください: { intervene: boolean, continued: boolean, reason: string, example: string }\n履歴:\n${historyText}`;
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini-2024-07-18",
    messages: [{role: "system", content: prompt}]
  });
  try {
    return JSON.parse(res.choices[0].message.content);
  } catch (e) {
    // JSONで返らなかった場合のフォールバック
    return { intervene: false, continued: false, reason: 'パース失敗', example: res.choices[0].message.content.trim() };
  }
}

// 既存のshouldContextuallyInterveneを新関数経由に
export async function shouldContextuallyIntervene(messages, lastIntervention = null) {
  const result = await shouldInterveneWithContinuation(messages, lastIntervention);
  if (result.intervene) {
    return result.example;
  }
  return null;
}

/**
 * 直近N件の履歴をテキスト化
 */
export function buildHistoryText(messages, n = 20) {
  return messages.slice(-n).map(m => `ユーザー: ${m.user}\nボッチー: ${m.bot}`).join("\n");
}

// 介入判定ロジック（トリガー/AI/確率）
function shouldInterveneStrict(message, context = {}) {
  // 1. 明示的トリガー
  if (/ボッチー|Bocchy/i.test(message.content)) {
    logInterventionDecision('explicit_trigger', message.content);
    return true;
  }
  // 2. AI判定（LLMプロンプトで"本当に必要な時だけ介入"を明示）
  if (context.aiInterventionResult && context.aiInterventionResult.intervene) {
    logInterventionDecision('ai_context', message.content);
    return true;
  }
  // 3. 確率判定（INTERVENTION_LEVEL=2）
  const level = 2;
  const result = Math.random() < level / 10;
  logInterventionDecision('probability', message.content, { level, result });
  return result;
}

// 介入後の会話フォロー（文脈・パーソナライズ重視）
async function buildContextForFollowup(supabase, userId, channelId, guildId = null, guild = null) {
  // 直近5件
  const { data: hist } = await supabase
    .from('conversation_histories')
    .select('messages')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .maybeSingle();
  const recent = (hist?.messages ?? []).slice(-5);
  // 150字要約
  const { data: sum } = await supabase
    .from('conversation_summaries')
    .select('summary')
    .eq('user_id', userId)
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // 相関サマリー
  let guildSummary = null;
  if (guildId) {
    const { data: gsum } = await supabase
      .from('guild_summaries')
      .select('summary')
      .eq('guild_id', guildId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    guildSummary = gsum?.summary || null;
  }
  // 最大公約数化パーソナライズ情報
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('profile_summary')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle();
  // プロンプト構成
  const contextMsgs = [];
  if (guildSummary) contextMsgs.push({ role: 'system', content: `[相関サマリー] ${guildSummary}` });
  if (sum?.summary) contextMsgs.push({ role: 'system', content: `[要約] ${sum.summary}` });
  if (profile?.profile_summary) contextMsgs.push({ role: 'system', content: `[パーソナライズ] ${profile.profile_summary}` });
  for (const msg of recent) {
    if (msg.content && /[？?]|help|困|教/.test(msg.content)) {
      contextMsgs.push(msg);
    }
  }
  // Token消費監視・自動圧縮
  let totalTokens = contextMsgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  while (totalTokens > 2000 && contextMsgs.length > 1) {
    contextMsgs.splice(1, 1); // system以外から古いものを削除
    totalTokens = contextMsgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  }
  // ログ出力
  console.log('[CONTEXT_BUILD]', { totalTokens, contextMsgs });
  return contextMsgs;
} 