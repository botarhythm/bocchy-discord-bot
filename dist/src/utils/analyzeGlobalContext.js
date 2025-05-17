import { openai, queuedOpenAI } from '../services/openai';
export async function analyzeGlobalContext(messages) {
    const res = await queuedOpenAI(() => openai.chat.completions.create({
        model: 'gpt-4.1-nano-2025-04-14',
        messages,
    }));
    // 必要に応じてレスポンスからtone, topics, summary等を抽出
    // ここではダミーで返す例
    return {
        tone: 'neutral',
        topics: [],
        summary: res.choices[0]?.message?.content || ''
    };
}
