// このファイルはアーカイブ用です。現行コードでは使用されていません。
// config/index.ts
// ボットの設定定数を環境変数から一元管理するよ🍃
import dotenv from 'dotenv';
dotenv.config();

export const BOT_CHAT_CHANNEL: string = process.env.BOT_CHAT_CHANNEL_ID || '1364622450918424576';
export const MAX_ACTIVE_TURNS: number = parseInt(process.env.MAX_ACTIVE_TURNS || '3', 10);
export const MAX_BOT_CONVO_TURNS: number = parseInt(process.env.MAX_BOT_CONVO_TURNS || '4', 10);
export const MAX_DAILY_RESPONSES: number = parseInt(process.env.MAX_DAILY_RESPONSES || '20', 10);
export const RESPONSE_WINDOW_START: number = parseInt(process.env.RESPONSE_WINDOW_START || '17', 10);
export const RESPONSE_WINDOW_END: number = parseInt(process.env.RESPONSE_WINDOW_END || '22', 10);
// 緊急停止フラグ: true の場合、メッセージ応答を停止するよ🚨
export const EMERGENCY_STOP: boolean = process.env.EMERGENCY_STOP === 'true'; 