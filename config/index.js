// config/index.js
// ボットの設定定数を環境変数から一元管理するよ🍃
import dotenv from 'dotenv';
dotenv.config();
export const BOT_CHAT_CHANNEL = process.env.BOT_CHAT_CHANNEL_ID || '1364622450918424576';
export const MAX_ACTIVE_TURNS = parseInt(process.env.MAX_ACTIVE_TURNS || '3', 10);
export const MAX_BOT_CONVO_TURNS = parseInt(process.env.MAX_BOT_CONVO_TURNS || '4', 10);
export const MAX_DAILY_RESPONSES = parseInt(process.env.MAX_DAILY_RESPONSES || '20', 10);
export const RESPONSE_WINDOW_START = parseInt(process.env.RESPONSE_WINDOW_START || '17', 10);
export const RESPONSE_WINDOW_END = parseInt(process.env.RESPONSE_WINDOW_END || '22', 10);
// 緊急停止フラグ: true の場合、メッセージ応答を停止するよ🚨
export const EMERGENCY_STOP = process.env.EMERGENCY_STOP === 'true'; 