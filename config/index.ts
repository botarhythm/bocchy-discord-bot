import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_KEY: z.string().min(1),
  BOT_CHAT_CHANNEL: z.string().optional(),
  MAX_ACTIVE_TURNS: z.string().optional(),
  MAX_BOT_CONVO_TURNS: z.string().optional(),
  MAX_DAILY_RESPONSES: z.string().optional(),
  RESPONSE_WINDOW_START: z.string().optional(),
  RESPONSE_WINDOW_END: z.string().optional(),
  EMERGENCY_STOP: z.string().optional(),
  // 必要に応じて他の環境変数も追加
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('環境変数のバリデーションに失敗:', parsed.error.format());
  throw new Error('環境変数のバリデーションに失敗しました');
}

export const config = parsed.data;

export const BOT_CHAT_CHANNEL = process.env.BOT_CHAT_CHANNEL || '';
export const MAX_ACTIVE_TURNS = Number(process.env.MAX_ACTIVE_TURNS) || 10;
export const MAX_BOT_CONVO_TURNS = Number(process.env.MAX_BOT_CONVO_TURNS) || 5;
export const MAX_DAILY_RESPONSES = Number(process.env.MAX_DAILY_RESPONSES) || 100;
export const RESPONSE_WINDOW_START = Number(process.env.RESPONSE_WINDOW_START) || 7;
export const RESPONSE_WINDOW_END = Number(process.env.RESPONSE_WINDOW_END) || 23;
export const EMERGENCY_STOP = process.env.EMERGENCY_STOP === 'true'; 