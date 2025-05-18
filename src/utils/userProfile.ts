import { openai } from '../services/openai.js';
// ユーザープロファイル履歴から要約を生成・更新する関数
// 必要に応じてDBや外部API連携部分は後で拡張可能な形で実装

export interface UserProfile {
  preferences?: Record<string, any>;
  profile_summary?: string;
  [key: string]: any;
}

/**
 * ユーザープロファイルの履歴から要約を生成し、保存する
 * @param {string} userId - ユーザーID
 * @param {Array} history - ユーザーの会話履歴（配列）
 * @param {function} saveSummary - 要約保存用コールバック（省略時は何もしない）
 * @returns {Promise<string>} 生成された要約
 */
export async function updateUserProfileSummaryFromHistory(userId: string, history: string[], saveSummary: (userId: string, summary: string) => Promise<void>): Promise<void> {
  const prompt = `以下はユーザーの会話履歴です。ユーザーの特徴や好み、傾向を200字以内で要約してください。\n---\n${history.join('\n')}\n---`;
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini-2024-07-18',
    messages: [
      { role: 'system', content: prompt }
    ]
  });
  const summary = res.choices[0]?.message?.content?.trim() || '';
  await saveSummary(userId, summary);
} 