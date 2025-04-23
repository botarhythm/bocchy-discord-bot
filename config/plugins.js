/**
 * プラグイン設定
 * 有効なプラグインとその設定を定義します
 */
const plugins = {
  ai: {
    name: 'AI Plugin',
    path: '../plugins/ai-plugin',
    enabled: true,
    config: {
      maxResponseLength: 2000,
      defaultLanguage: 'ja',
      timeoutSeconds: 30,
      allowedEmojis: true,
      allowedMarkdown: true,
      allowedHtml: false
    }
  },
  database: {
    name: 'Database Plugin',
    path: '../plugins/database-plugin',
    enabled: true,
    config: {
      maxConnections: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000
    }
  }
};

module.exports = plugins; 