// ユーザープロファイル履歴から要約を生成・更新する関数
// 必要に応じてDBや外部API連携部分は後で拡張可能な形で実装

/**
 * ユーザープロファイルの履歴から要約を生成し、保存する
 * @param {string} userId - ユーザーID
 * @param {Array} history - ユーザーの会話履歴（配列）
 * @param {function} saveSummary - 要約保存用コールバック（省略時は何もしない）
 * @returns {Promise<string>} 生成された要約
 */
export async function updateUserProfileSummaryFromHistory(userId, history, saveSummary) {
  if (!userId || !Array.isArray(history)) {
    throw new Error('userIdまたはhistoryが不正です');
  }
  // LLMで履歴から要約生成
  const formatted = history.slice(-10).map(msg => msg.content || '').join('\n');
  const prompt = `以下はユーザーの直近の発言履歴です。この人の「好み・傾向・要望」を日本語で簡潔に要約してください。\n---\n${formatted}`;
  let summary = '';
  try {
    const openai = new (await import('openai')).OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await openai.chat.completions.create({
      model: 'gpt-4.1-nano-2025-04-14',
      messages: [
        { role: 'system', content: 'あなたはユーザープロファイル要約AIです。' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 128,
      temperature: 0.2
    });
    summary = res.choices[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.warn('[updateUserProfileSummaryFromHistory] LLM要約失敗', e);
    summary = `最近の発言要約: ${formatted.substring(0, 200)}...`;
  }
  if (typeof saveSummary === 'function') {
    try {
      await saveSummary(userId, summary);
    } catch (err) {
      console.error('要約保存時にエラー:', err);
    }
  }
  return summary;
} 