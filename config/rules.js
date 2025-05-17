// このファイルはアーカイブ用です。現行コードでは使用されていません。
// Bocchy Bot ルール・運用・MCP・GitHub情報集約

const coreRules = {
  principles: [
    'すべてのコードはモジュール化し、再利用可能な形で実装',
    '関数は単一責任の原則に従い、一つの機能に集中',
    'エラーハンドリングは常に明示的に行い、適切なエラーメッセージを提供'
  ],
  naming: {
    variable: 'camelCase',
    constant: 'UPPER_SNAKE_CASE',
    class: 'PascalCase'
  },
  structure: [
    '各モジュールは明確な役割を持ち、依存を最小限に',
    '設定値はconfig/rules.jsに集約しハードコーディング禁止',
    '外部APIリクエストはタイムアウト・リトライ必須',
    'LLM活用を最優先し、シンプルなプログラミングで最大化'
  ]
};

const bocchyRules = {
  BASE: {
    maxResponseLength: 2000,
    defaultLanguage: 'ja',
    timeoutSeconds: 30
  },
  CONVERSATION: {
    maxTurns: 10,
    minMessageLength: 2,
    maxMessageLength: 1000,
    cooldownSeconds: 1
  },
  LIMITATIONS: {
    maxDailyMessages: 100,
    maxConcurrentSessions: 3,
    maxAttachmentSize: '5MB'
  },
  CUSTOMIZATION: {
    allowedEmojis: true,
    allowedMarkdown: true,
    allowedHtml: false
  },
  TESTING: {
    testExecutor: 'cursor',
    debugExecutor: 'cursor',
    testValidation: 'cursor',
    humanRole: 'reviewer'
  },
  policy: {
    test: [
      'すべてのテスト実行はCursorが担当',
      'テスト結果の解析・問題特定もCursorが実施',
      '人間はレビューと承認のみ',
      'テストの自動化・継続的実行を推進'
    ],
    debug: [
      'エラー検出・原因特定はCursorが実施',
      'デバッグ作業の実行・検証もCursorが担当',
      '人間はデバッグ方針の承認と最終確認のみ',
      'すべてのデバッグ作業はログを残し追跡可能に'
    ]
  }
};

const mpcConfig = {
  github: {
    repoUrl: 'https://github.com/botarhythm/bocchy-discord-bot.git',
    mainBranch: 'main',
    pat: '[REDACTED]'
  },
  railway: {
    projectId: '13f5d497-6af5-4f86-9c71-1ac00d608a5c',
    environmentId: '4e5d0a52-c99a-43b0-8bb7-4c1a0f25c4c3',
    serviceId: '15793137-d605-4c2e-86b7-a233f188f5c3',
    apiToken: '[REDACTED]',
    publicUrl: 'botchi-discord-bot-production.up.railway.app'
  },
  supabase: {
    projectUrl: '[非公開]',
    apiKey: '[非公開]',
    serviceRole: '[非公開]',
    vectorStore: {
      table: 'embeddings',
      similarityThreshold: 0.75,
      maxResults: 5,
      contextLength: 2000
    }
  },
  ci: {
    githubActions: '.github/workflows/deploy.yml',
    railwayAutoDeploy: true,
    healthCheck: '/health',
    maxRetry: 10
  }
};

const githubInfo = {
  owner: 'botarhythm',
  repo: 'bocchy-discord-bot'
};

// Railway MCP接続情報
const RAILWAY_PROJECT_ID = '13f5d497-6af5-4f86-9c71-1ac00d608a5c';
const RAILWAY_ENVIRONMENT_ID = '4e5d0a52-c99a-43b0-8bb7-4c1a0f25c4c3';
const RAILWAY_SERVICE_ID = '15793137-d605-4c2e-86b7-a233f188f5c3';
const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN || '[REDACTED]';

module.exports = {
  coreRules,
  bocchyRules,
  mpcConfig,
  githubInfo,
  RAILWAY_PROJECT_ID,
  RAILWAY_ENVIRONMENT_ID,
  RAILWAY_SERVICE_ID,
  RAILWAY_API_TOKEN,
}; 