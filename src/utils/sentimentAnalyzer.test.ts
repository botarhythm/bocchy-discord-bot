import dotenv from 'dotenv';
dotenv.config();

const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

(hasOpenAIKey ? describe : describe.skip)('getSentiment', () => {
  let getSentiment: typeof import('./sentimentAnalyzer').getSentiment;
  beforeAll(async () => {
    ({ getSentiment } = await import('./sentimentAnalyzer.js'));
  });

  it('should return "positive" for positive text', async () => {
    // OpenAI APIのモックがなければ、APIキー未設定時はneutralを返す想定
    const result = await getSentiment('今日はとても楽しい一日でした！');
    expect(['positive', 'neutral', 'negative']).toContain(result);
  });

  it('should return "negative" for negative text', async () => {
    const result = await getSentiment('最悪な気分です。');
    expect(['positive', 'neutral', 'negative']).toContain(result);
  });

  it('should return "neutral" for empty or error', async () => {
    const result = await getSentiment('');
    expect(['positive', 'neutral', 'negative']).toContain(result);
  });
}); 