import { OpenAI } from 'openai';
import { env } from '../../config/index.js';
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
export async function llmRespond(prompt, systemPrompt = '', message = null, history = [], charPrompt = null) {
    const systemCharPrompt = charPrompt ?? (message ? '' : '');
    const messages = [
        { role: 'system', content: systemCharPrompt + (systemPrompt ? `\n${systemPrompt}` : '') },
        ...history,
        { role: 'user', content: prompt }
    ];
    const res = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages
    });
    return res.choices?.[0]?.message?.content?.trim() ?? '';
}
