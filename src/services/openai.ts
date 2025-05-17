import { OpenAI } from 'openai';
import PQueue from 'p-queue';

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEYが設定されていません');
}

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// OpenAI API呼び出しをバッチ化・レートリミット制御
const openaiQueue = new PQueue({ interval: 60_000, intervalCap: 60 });

export async function queuedOpenAI<T>(fn: () => Promise<T>): Promise<T> {
  return openaiQueue.add(fn);
} 