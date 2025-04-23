const assert = require('assert');
const DatabasePlugin = require('../plugins/database-plugin');
const config = require('../config/plugins');

describe('Database Plugin', () => {
  let plugin;
  
  beforeEach(async () => {
    plugin = new DatabasePlugin(config.plugins.database, {});
    await plugin.initialize();
  });

  afterEach(async () => {
    await plugin.cleanup();
  });

  it('プラグインが正しく初期化されること', () => {
    assert.ok(plugin);
    assert.strictEqual(typeof plugin.initialize, 'function');
    assert.strictEqual(typeof plugin.query, 'function');
    assert.strictEqual(typeof plugin.cleanup, 'function');
  });

  it('データベース接続が確立されること', async () => {
    const isConnected = await plugin.checkConnection();
    assert.strictEqual(isConnected, true);
  });

  it('クエリが正しく実行されること', async () => {
    const testData = { id: 1, name: 'テストユーザー' };
    await plugin.insert('users', testData);
    
    const result = await plugin.query('SELECT * FROM users WHERE id = $1', [1]);
    assert.deepStrictEqual(result[0], testData);
  });

  it('トランザクションが正しく機能すること', async () => {
    const client = await plugin.beginTransaction();
    try {
      await client.query('INSERT INTO users (id, name) VALUES ($1, $2)', [2, 'トランザクションテスト']);
      await plugin.commitTransaction(client);
      
      const result = await plugin.query('SELECT * FROM users WHERE id = $1', [2]);
      assert.strictEqual(result[0].name, 'トランザクションテスト');
    } catch (error) {
      await plugin.rollbackTransaction(client);
      throw error;
    }
  });

  it('エラー時にトランザクションがロールバックされること', async () => {
    const client = await plugin.beginTransaction();
    try {
      await client.query('INSERT INTO users (id, name) VALUES ($1, $2)', [3, 'ロールバックテスト']);
      // エラーを発生させる
      await client.query('INSERT INTO non_existent_table VALUES ($1)', [1]);
      await plugin.commitTransaction(client);
      assert.fail('エラーが発生するはずです');
    } catch (error) {
      await plugin.rollbackTransaction(client);
      // ロールバックされたことを確認
      const result = await plugin.query('SELECT * FROM users WHERE id = $1', [3]);
      assert.strictEqual(result.length, 0);
    }
  });
}); 