// Jest TypeScript(CJS)対応設定
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: false }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testPathIgnorePatterns: [
    '/node_modules/',
    '/_archive/',
    '/archive/',
    '/plugins/',
    '/dist/',
    '/test/ai-plugin.test.js',
    '/test/plugin-system.test.js',
    '/test/database-plugin.test.js',
    '/test/handlers/',
    '/test/railway-mcp.test.js',
    '/test/ai-service.test.js',
    '/test/bot-integration.test.js',
  ],
}; 