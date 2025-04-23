const { expect } = require('chai');
const { Client, GatewayIntentBits } = require('discord.js');
const aiService = require('../core/ai-service');

describe('Botchiボット統合テスト', () => {
  let client;

  before(() => {
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
      ]
    });
  });

  describe('Discord接続テスト', () => {
    it('クライアントが正しく初期化されること', () => {
      expect(client).to.be.an('object');
      expect(client.isReady()).to.be.false;
    });

    it('必要なイベントハンドラが設定されていること', () => {
      expect(client.eventNames()).to.include('ready');
      expect(client.eventNames()).to.include('messageCreate');
      expect(client.eventNames()).to.include('interactionCreate');
    });
  });

  describe('AI機能テスト', () => {
    it('AIサービスが利用可能であること', () => {
      expect(aiService).to.be.an('object');
      expect(aiService.processMessage).to.be.a('function');
    });

    it('メッセージ処理が正しく動作すること', async () => {
      const testMessage = 'こんにちは';
      const response = await aiService.processMessage(testMessage);
      expect(response).to.be.a('string');
      expect(response.length).to.be.greaterThan(0);
    });

    it('エラー時に適切に処理されること', async () => {
      try {
        await aiService.processMessage(null);
        expect.fail('エラーが発生するはずです');
      } catch (error) {
        expect(error).to.be.an('error');
      }
    });
  });

  describe('コマンド処理テスト', () => {
    it('スラッシュコマンドが登録されていること', () => {
      const commands = client.application?.commands.cache;
      expect(commands).to.not.be.empty;
    });

    it('ヘルプコマンドが正しく応答すること', async () => {
      const helpCommand = client.application?.commands.cache
        .find(cmd => cmd.name === 'help');
      expect(helpCommand).to.exist;
      // コマンド実行のシミュレーション
      const response = await helpCommand.execute();
      expect(response).to.be.an('object');
      expect(response.content).to.include('使い方');
    });
  });

  describe('メッセージ処理テスト', () => {
    it('通常のメッセージに応答できること', async () => {
      const mockMessage = {
        content: 'テストメッセージ',
        author: { bot: false },
        reply: async (content) => content
      };
      const response = await client.emit('messageCreate', mockMessage);
      expect(response).to.be.true;
    });

    it('システムメッセージを無視すること', async () => {
      const mockSystemMessage = {
        content: 'システムメッセージ',
        author: { bot: true }
      };
      const response = await client.emit('messageCreate', mockSystemMessage);
      expect(response).to.be.false;
    });
  });

  after(() => {
    if (client) {
      client.destroy();
    }
  });
}); 