// NLPによる主語候補抽出ユーティリティ
// bocchy_core_rules準拠

/**
 * 日本語文から主語候補を抽出する（簡易版）
 * 本実装は形態素解析APIやライブラリ連携を想定し、ここでは疑似ロジック
 */
export function extractSubjectCandidates(text: string): string[] {
  // TODO: 本番ではkuromoji.jsや外部NLP APIと連携
  // ここでは「私」「ボッチー」「あなた」などの単純なパターンで抽出
  const candidates: string[] = [];
  if (text.includes('ボッチー')) candidates.push('ボッチー');
  if (text.includes('私')) candidates.push('ユーザー');
  if (text.includes('あなた')) candidates.push('ユーザー');
  // 他にも固有名詞や代名詞を追加
  return candidates;
} 