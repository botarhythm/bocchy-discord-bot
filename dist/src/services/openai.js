import { OpenAI } from 'openai';
import PQueue from 'p-queue';
if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEYが設定されていません');
}
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
// OpenAI API呼び出しをバッチ化・レートリミット制御
const openaiQueue = new PQueue({ interval: 60_000, intervalCap: 60 });
export async function queuedOpenAI(fn) {
    let attempt = 0;
    const maxAttempts = 5;
    let delay = 1000;
    while (true) {
        try {
            return (await openaiQueue.add(fn));
        }
        catch (err) {
            const code = err?.status || err?.code || err?.response?.status;
            if ((code === 429 || code === 502) && attempt < maxAttempts) {
                await new Promise(res => setTimeout(res, delay));
                attempt++;
                delay *= 2; // Exponential backoff
                continue;
            }
            throw err;
        }
    }
}
