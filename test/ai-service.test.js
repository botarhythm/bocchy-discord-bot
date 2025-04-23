const { expect } = require('chai');
const AIService = require('../core/ai-service');
const MockDiscordClient = require('./mocks/discord-client');

describe('AIService', () => {
  let aiService;
  let mockClient;

  beforeEach(() => {
    mockClient = new MockDiscordClient();
    aiService = new AIService(mockClient);
  });

  describe('processMessage', () => {
    it('正常なメッセージを処理できること', async () => {
      const result = await aiService.processMessage('こんにちは');
      expect(result).to.be.an('object');
      expect(result.response).to.be.a('string');
    });

    it('無効なメッセージでエラーを返すこと', async () => {
      try {
        await aiService.processMessage('');
        expect.fail('エラーが発生するはずです');
      } catch (error) {
        expect(error.message).to.equal('無効なメッセージ形式です');
      }
    });
  });

  describe('checkHealth', () => {
    it('ヘルスチェックが正常に動作すること', () => {
      const health = aiService.checkHealth();
      expect(health).to.be.an('object');
      expect(health.status).to.equal('healthy');
      expect(health.timestamp).to.be.a('number');
    });
  });

  describe('isReady', () => {
    it('システムの準備状態を確認できること', () => {
      const ready = aiService.isReady();
      expect(ready).to.be.true;
    });
  });
}); 