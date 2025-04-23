class MockDiscordClient {
  constructor() {
    this.user = { id: 'mock-bot-id', username: 'MockBot' };
    this.eventHandlers = new Map();
  }

  // イベントハンドラーを登録
  on(event, handler) {
    this.eventHandlers.set(event, handler);
    return this;
  }

  // イベントを発火
  emit(event, ...args) {
    const handler = this.eventHandlers.get(event);
    if (handler) {
      handler(...args);
    }
  }

  // ログイン処理をモック
  login(token) {
    return Promise.resolve('Logged in successfully');
  }

  // メッセージ送信をモック
  async send(content) {
    return {
      content,
      id: 'mock-message-id',
      channelId: 'mock-channel-id'
    };
  }
}

module.exports = MockDiscordClient; 