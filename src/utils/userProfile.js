// ユーザープロファイル履歴から要約を生成・更新する関数
// 必要に応じてDBや外部API連携部分は後で拡張可能な形で実装

/**
 * ユーザープロファイルの履歴から要約を生成し、保存する
 * @param {string} userId - ユーザーID
 * @param {Array} history - ユーザーの会話履歴（配列）
 * @param {function} saveSummary - 要約保存用コールバック（省略時は何もしない）
 * @returns {Promise<string>} 生成された要約
 */
async function updateUserProfileSummaryFromHistory(userId, history, saveSummary) {
  if (!userId || !Array.isArray(history)) {
    throw new Error('userIdまたはhistoryが不正です');
  }
  // 履歴から要約を生成（ここでは単純に最新5件を連結して要約とする例）
  const recent = history.slice(-5).map(msg => msg.content || '').join(' ');
  // TODO: LLM等で要約生成する場合はここでAPI呼び出し
  const summary = `最近の発言要約: ${recent.substring(0, 200)}...`;
  if (typeof saveSummary === 'function') {
    try {
      await saveSummary(userId, summary);
    } catch (err) {
      console.error('要約保存時にエラー:', err);
    }
  }
  return summary;
}

module.exports = {
  updateUserProfileSummaryFromHistory,
}; 