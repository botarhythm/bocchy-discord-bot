import { OpenAI } from 'openai';
import { env } from '../config/index.js';
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
export async function llmRespond(prompt, systemPrompt = '', message = null, history = [], charPrompt = null) {
    const systemCharPrompt = charPrompt ?? (message ? '' : '');
    const messages = [
        { role: 'system', content: systemCharPrompt + (systemPrompt ? `\n${systemPrompt}` : '') },
        ...history,
        { role: 'user', content: prompt }
    ];
    const res = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        messages
    });
    return res.choices?.[0]?.message?.content?.trim() ?? '';
}
export async function openaiSummarize(prompt) {
    try {
        const res = await openai.chat.completions.create({
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            messages: [
                { role: 'system', content: 'あなたはDiscordボット「ボッチー」です。キャラクター性を守り、優しい・親しみやすい日本語で要約してください。' },
                { role: 'user', content: prompt },
            ],
            max_tokens: 300,
            temperature: 0.7,
        });
        return res.choices?.[0]?.message?.content?.trim() ?? '';
    }
    catch (e) {
        console.error('[ERROR] openaiSummarize failed:', e);
        return '要約生成中にエラーが発生しました。';
    }
}
