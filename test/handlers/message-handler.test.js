const chai = require('chai');
const sinon = require('sinon');
const { expect } = chai;
const messageHandler = require('../../botchi-current/handlers/message-handler');
const logger = require('../../botchi-current/utils/logger');
const contextHandler = require('../../botchi-current/handlers/context-handler');
const { OpenAIService } = require('../../botchi-current/services/ai/openai-service');

describe('メッセージハンドラーのテスト', () => {
  let sandbox;
  let mockMessage;
  let mockClient;
  let mockAIService;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    
    // モックの作成
    mockMessage = {
      content: 'テストメッセージ',
      author: {
        bot: false,
        id: '123',
        tag: 'testUser#1234',
        username: 'testUser'
      },
      channel: {
        id: '456',
        type: 0,
        name: 'test-channel',
        sendTyping: sandbox.stub().resolves()
      },
      mentions: {
        has: sandbox.stub().returns(false)
      },
      reply: sandbox.stub().resolves()
    };

    mockClient = {
      user: {
        id: '789'
      }
    };

    mockAIService = {
      processMessage: sandbox.stub().resolves('AIの応答'),
      initialize: sandbox.stub().resolves(),
      shutdown: sandbox.stub().resolves()
    };

    // スタブの設定
    sandbox.stub(logger, 'debug');
    sandbox.stub(logger, 'info');
    sandbox.stub(logger, 'error');
    sandbox.stub(contextHandler, 'shouldIntervene').resolves({ shouldIntervene: false });
    sandbox.stub(contextHandler, 'generateContextResponse').resolves('文脈応答');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('基本機能テスト', () => {
    it('botからのメッセージは無視される', async () => {
      mockMessage.author.bot = true;
      await messageHandler.handleMessage(mockMessage);
      expect(mockMessage.reply.called).to.be.false;
    });

    it('空のメッセージは処理されない', async () => {
      mockMessage.content = '';
      await messageHandler.handleMessage(mockMessage);
      expect(mockMessage.reply.called).to.be.false;
    });

    it('メンションされた場合はAI応答を生成する', async () => {
      mockMessage.mentions.has.returns(true);
      messageHandler.setAIProvider(mockAIService);
      await messageHandler.handleMessage(mockMessage);
      expect(mockMessage.channel.sendTyping.called).to.be.true;
    });
  });

  describe('文脈介入テスト', () => {
    it('文脈介入が必要な場合は介入応答を生成する', async () => {
      contextHandler.shouldIntervene.resolves({ shouldIntervene: true });
      await messageHandler.handleMessage(mockMessage);
      expect(contextHandler.generateContextResponse.called).to.be.true;
    });

    it('文脈介入が不要な場合は介入応答を生成しない', async () => {
      contextHandler.shouldIntervene.resolves({ shouldIntervene: false });
      await messageHandler.handleMessage(mockMessage);
      expect(contextHandler.generateContextResponse.called).to.be.false;
    });
  });

  describe('エラーハンドリングテスト', () => {
    it('AI処理中のエラーを適切に処理する', async () => {
      mockMessage.mentions.has.returns(true);
      messageHandler.setAIProvider(mockAIService);
      mockAIService.processMessage.rejects(new Error('AI処理エラー'));
      
      await messageHandler.handleMessage(mockMessage);
      expect(logger.error.called).to.be.true;
    });

    it('文脈介入処理中のエラーを適切に処理する', async () => {
      contextHandler.shouldIntervene.resolves({ shouldIntervene: true });
      contextHandler.generateContextResponse.rejects(new Error('文脈処理エラー'));
      
      await messageHandler.handleMessage(mockMessage);
      expect(logger.error.called).to.be.true;
    });
  });

  describe('DM処理テスト', () => {
    it('DMの場合は常にAI応答を生成する', async () => {
      mockMessage.channel.type = 1; // DMチャンネル
      messageHandler.setAIProvider(mockAIService);
      await messageHandler.handleMessage(mockMessage);
      expect(mockMessage.channel.sendTyping.called).to.be.true;
    });
  });

  describe('検索機能テスト', () => {
    it('検索トリガーを含むメッセージを適切に処理する', async () => {
      mockMessage.content = '検索：テストクエリ';
      mockMessage.mentions.has.returns(true);
      messageHandler.setAIProvider(mockAIService);
      
      await messageHandler.handleMessage(mockMessage);
      expect(mockMessage.channel.sendTyping.called).to.be.true;
    });
  });
}); 