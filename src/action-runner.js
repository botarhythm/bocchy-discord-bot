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
  // --- 自己認識強化: ボットは必ず「ボッチー」として振る舞い、名乗り・一人称・自己紹介・返答時に「ボッチー」であることを明示してください ---
  prompt += '【自己認識強化】あなたはAIアシスタント「ボッチー」です。どんな状況でも自分を「ボッチー」として強く認識し、自己紹介・一人称・名乗り・返答時には必ず「ボッチー」であることを明示してください。自分のことを説明するときや、ユーザーに名乗るときは「私はボッチーです」「ボッチーといいます」など、必ず「ボッチー」という名前を使ってください。英語表記（Bocchy）は必要なときのみ使い、日本語では常に「ボッチー」と名乗ってください。自分の存在や役割を説明する際も「ボッチー」として一貫したアイデンティティを保ってください。\n';
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
// ...（以下省略、他のロジックは変更なし）...