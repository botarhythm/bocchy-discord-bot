import { ConversationSummaryMemory } from 'langchain/memory';
import { OpenAI } from 'openai';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// LangChainの会話要約メモリを初期化
const memory = new ConversationSummaryMemory({
  llm: openai,
  memoryKey: 'summary',
  inputKey: 'input',
  outputKey: 'output',
});

/**
 * 会話全体の話題・遷移・感情トーンを要約・分析
 * @param {Array<{user: string, bot: string}>} history
 * @returns {Promise<{topics: string[], tone: string, summary: string}>}
 */
export async function analyzeGlobalContext(history) {
  // LangChainで会話要約
  const formatted = history.map(h => `ユーザー: ${h.user}\nボット: ${h.bot}`).join('\n');
  await memory.saveContext({ input: formatted }, { output: '' });
  const summary = await memory.loadMemoryVariables({});

  // GPT-4o-miniで話題・トーン抽出
  const prompt = `以下の会話履歴から「主な話題リスト」「全体の感情トーン（例: 楽しい・真面目・ネガティブ等）」を日本語で簡潔に抽出してください。\n---\n${formatted}`;
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini-2024-07-18',
    messages: [
      { role: 'system', content: prompt }
    ]
  });
  const content = res.choices[0]?.message?.content?.trim() || '';
  // シンプルなパース例
  const topics = (content.match(/話題リスト[:：](.*)/)?.[1] || '').split(/[、,・\n]/).map(s => s.trim()).filter(Boolean);
  const tone = content.match(/トーン[:：](.*)/)?.[1] || '';
  return {
    topics,
    tone,
    summary: summary.summary || ''
  };
} 