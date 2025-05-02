import { pipeline } from '@xenova/transformers';

let sentimentPipeline = null;

export async function getSentiment(text) {
  if (!sentimentPipeline) {
    sentimentPipeline = await pipeline('sentiment-analysis', 'Xenova/bert-base-japanese-sentiment');
  }
  try {
    const result = await sentimentPipeline(text);
    // [{ label: 'ポジティブ', score: 0.98 }]
    const label = result[0]?.label || 'ニュートラル';
    if (label.includes('ポジティブ')) return 'positive';
    if (label.includes('ネガティブ')) return 'negative';
    return 'neutral';
  } catch (e) {
    console.error('[sentimentAnalyzer] 感情分析失敗:', e);
    return 'neutral';
  }
} 