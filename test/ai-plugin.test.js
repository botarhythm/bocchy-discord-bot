const assert = require('assert');
const sinon = require('sinon');
const AIPlugin = require('../plugins/ai-plugin');
const pluginSystem = require('../archive/extensions/plugin-system');

describe('AIプラグイン', function() {
  // タイムアウトを延長
  this.timeout(5000);

  let aiPlugin;
  let mockClient;
  let mockAIService;
  let mockChannel;

  beforeEach(() => {
    // モックの設定
    mockChannel = {
      send: sinon.stub().resolves()
    };

    mockClient = {
      // Discordクライアントのモック
    };

    mockAIService = {
      initialize: sinon.stub().resolves(),
      processMessage: sinon.stub().resolves('テスト応答'),
      shutdown: sinon.stub().resolves()
    };

    // プラグインのインスタンス化
    aiPlugin = new AIPlugin({
      client: mockClient,
      config: {
        maxResponseLength: 2000,
        defaultLanguage: 'ja',
        timeoutSeconds: 30,
        retryAttempts: 3
      },
      aiService: mockAIService
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('初期化', () => {
    it('正しく初期化される', async () => {
      await aiPlugin.initialize();
      assert(mockAIService.initialize.calledOnce);
      assert(aiPlugin.isInitialized);
    });

    it('AIサービスが設定されていない場合はエラーを投げる', async () => {
      aiPlugin.aiService = null;
      await assert.rejects(
        aiPlugin.initialize(),
        /AIサービスが設定されていません/
      );
    });

    it('初期化エラーを適切に処理する', async () => {
      mockAIService.initialize.rejects(new Error('初期化エラー'));
      await assert.rejects(
        aiPlugin.initialize(),
        /初期化エラー/
      );
      assert(!aiPlugin.isInitialized);
      assert(aiPlugin.lastError);
    });
  });

  describe('メッセージ処理', () => {
    beforeEach(async () => {
      await aiPlugin.initialize();
    });

    it('メッセージを正しく処理して応答する', async () => {
      const message = {
        content: 'こんにちは',
        channel: mockChannel
      };

      await aiPlugin.handleMessage(message);
      assert(mockAIService.processMessage.calledWith('こんにちは'));
      assert(mockChannel.send.calledWith('テスト応答'));
    });

    it('初期化されていない場合はエラーを投げる', async () => {
      aiPlugin.isInitialized = false;
      const message = {
        content: 'テスト',
        channel: mockChannel
      };

      await aiPlugin.handleMessage(message);
      assert(mockChannel.send.calledWith('申し訳ありません。応答の生成中にエラーが発生しました。'));
    });

    it('長い応答を適切に分割する', async () => {
      const longResponse = '。'.repeat(3000);
      mockAIService.processMessage.resolves(longResponse);
      
      const message = {
        content: 'テスト',
        channel: mockChannel
      };

      await aiPlugin.handleMessage(message);
      assert(mockChannel.send.callCount > 1);
    });
  });

  describe('応答生成', () => {
    it('リトライメカニズムが正しく動作する', async () => {
      mockAIService.processMessage
        .onFirstCall().rejects(new Error('一時的なエラー'))
        .onSecondCall().resolves('成功');

      const response = await aiPlugin.generateResponse('テスト');
      assert.strictEqual(response, '成功');
      assert.strictEqual(mockAIService.processMessage.callCount, 2);
    });

    it('最大リトライ回数を超えた場合はエラーを投げる', async () => {
      mockAIService.processMessage.rejects(new Error('永続的なエラー'));

      await assert.rejects(
        () => aiPlugin.generateResponse('テスト'),
        /応答生成に失敗しました/
      );
      assert.strictEqual(mockAIService.processMessage.callCount, 3);
    });
  });

  describe('応答の分割', () => {
    it('日本語の文章を適切に分割する', () => {
      const response = 'これは。テストです。長い文章です。';
      const chunks = aiPlugin.splitResponse(response);
      assert.strictEqual(chunks.length, 1);
      assert.strictEqual(chunks[0], response);
    });

    it('長い文章を適切に分割する', () => {
      const response = '。'.repeat(3000);
      const chunks = aiPlugin.splitResponse(response);
      assert(chunks.length > 1);
      chunks.forEach(chunk => {
        assert(chunk.length <= aiPlugin.maxResponseLength);
      });
    });
  });

  describe('状態管理', () => {
    it('正しい状態情報を返す', () => {
      const status = aiPlugin.getStatus();
      assert(status.hasOwnProperty('initialized'));
      assert(status.hasOwnProperty('uptime'));
      assert(status.hasOwnProperty('config'));
      assert.deepStrictEqual(status.config, {
        maxResponseLength: 2000,
        defaultLanguage: 'ja',
        timeoutSeconds: 30,
        retryAttempts: 3
      });
    });
  });

  describe('シャットダウン', () => {
    it('正しくシャットダウンする', async () => {
      await aiPlugin.shutdown();
      assert(mockAIService.shutdown.calledOnce);
      assert(!aiPlugin.isInitialized);
    });

    it('シャットダウンエラーを適切に処理する', async () => {
      mockAIService.shutdown.rejects(new Error('シャットダウンエラー'));
      await assert.rejects(
        aiPlugin.shutdown(),
        /シャットダウンエラー/
      );
    });
  });

  describe('プラグインシステム統合', () => {
    it('プラグインシステムに正しく登録される', async () => {
      await pluginSystem.registerPlugin('ai', aiPlugin);
      const registeredPlugin = pluginSystem.getPlugin('ai');
      assert.strictEqual(registeredPlugin, aiPlugin);
    });

    it('プラグインの状態が正しく報告される', () => {
      const status = aiPlugin.getStatus();
      assert(status.hasOwnProperty('initialized'));
      assert(status.hasOwnProperty('ready'));
    });
  });

  describe('エラーハンドリング', () => {
    it('メッセージ処理エラーを適切に処理する', async () => {
      mockAIService.processMessage.rejects(new Error('処理エラー'));
      await assert.rejects(
        () => aiPlugin.processMessage('test'),
        /処理エラー/
      );
    });
  });

  describe('AIPlugin', () => {
    let aiPlugin;
    let mockAIService;

    beforeEach(() => {
      aiPlugin = new AIPlugin();
      mockAIService = {
        initialize: sinon.stub().resolves(),
        processMessage: sinon.stub().resolves('応答テスト'),
        shutdown: sinon.stub().resolves()
      };
      aiPlugin.setAIService(mockAIService);
    });

    describe('初期化テスト', () => {
      it('未初期化状態でメッセージを処理しようとするとエラーになる', async () => {
        await expect(aiPlugin.handleMessage('テスト'))
          .to.be.rejectedWith('処理エラー: プラグインが初期化されていません');
      });

      it('初期化後にreadyがtrueになる', async () => {
        await aiPlugin.initialize();
        expect(aiPlugin.ready).to.be.true;
      });
    });

    describe('メッセージ処理テスト', () => {
      beforeEach(async () => {
        await aiPlugin.initialize();
      });

      it('タイムアウトまでに応答が返ってこない場合はエラーになる', async function() {
        this.timeout(15000);
        mockAIService.processMessage.restore();
        mockAIService.processMessage = sinon.stub().returns(new Promise(resolve => setTimeout(resolve, 12000)));
        
        await expect(aiPlugin.handleMessage('テスト'))
          .to.be.rejectedWith('タイムアウト: 応答を生成できませんでした');
      });
    });
  });
}); 