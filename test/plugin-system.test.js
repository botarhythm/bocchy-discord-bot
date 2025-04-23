const assert = require('assert');
const pluginSystem = require('../archive/extensions/plugin-system');

describe('Plugin System', () => {
  beforeEach(() => {
    // 各テスト前にプラグインシステムをリセット
    pluginSystem.plugins.clear();
  });

  describe('プラグイン登録と取得', () => {
    it('プラグインを正しく登録できること', () => {
      const testPlugin = {
        name: 'testPlugin',
        initialize: async () => {}
      };
      
      pluginSystem.registerPlugin('test', testPlugin);
      assert.strictEqual(pluginSystem.plugins.size, 1);
      assert.strictEqual(pluginSystem.plugins.get('test'), testPlugin);
    });

    it('存在しないプラグインへのアクセスでnullが返されること', () => {
      const plugin = pluginSystem.getPlugin('nonexistent');
      assert.strictEqual(plugin, null);
    });

    it('登録済みのプラグインを取得できること', () => {
      const testPlugin = {
        name: 'testPlugin',
        initialize: async () => {}
      };
      
      pluginSystem.registerPlugin('test', testPlugin);
      const retrievedPlugin = pluginSystem.getPlugin('test');
      assert.strictEqual(retrievedPlugin, testPlugin);
    });

    it('全てのプラグインを取得できること', () => {
      const plugin1 = { name: 'plugin1', initialize: async () => {} };
      const plugin2 = { name: 'plugin2', initialize: async () => {} };
      
      pluginSystem.registerPlugin('test1', plugin1);
      pluginSystem.registerPlugin('test2', plugin2);
      
      const allPlugins = pluginSystem.getAllPlugins();
      assert.strictEqual(allPlugins.size, 2);
      assert.strictEqual(allPlugins.get('test1'), plugin1);
      assert.strictEqual(allPlugins.get('test2'), plugin2);
    });
  });

  describe('プラグインの初期化', () => {
    it('全てのプラグインが正しく初期化されること', async () => {
      let initialized1 = false;
      let initialized2 = false;
      
      const plugin1 = {
        name: 'plugin1',
        initialize: async () => { initialized1 = true; }
      };
      
      const plugin2 = {
        name: 'plugin2',
        initialize: async () => { initialized2 = true; }
      };
      
      pluginSystem.registerPlugin('test1', plugin1);
      pluginSystem.registerPlugin('test2', plugin2);
      
      await pluginSystem.initializePlugins();
      
      assert.strictEqual(initialized1, true);
      assert.strictEqual(initialized2, true);
    });

    it('初期化エラーが適切に処理されること', async () => {
      const errorPlugin = {
        name: 'errorPlugin',
        initialize: async () => {
          throw new Error('初期化エラー');
        }
      };
      
      pluginSystem.registerPlugin('error', errorPlugin);
      
      try {
        await pluginSystem.initializePlugins();
        assert.fail('エラーが発生するはずです');
      } catch (error) {
        assert.strictEqual(error.message, '初期化エラー');
      }
    });
  });

  describe('プラグインの依存関係', () => {
    it('依存関係のあるプラグインが正しい順序で初期化されること', async () => {
      const initOrder = [];
      
      const plugin1 = {
        name: 'plugin1',
        dependencies: [],
        initialize: async () => { initOrder.push('plugin1'); }
      };
      
      const plugin2 = {
        name: 'plugin2',
        dependencies: ['plugin1'],
        initialize: async () => { initOrder.push('plugin2'); }
      };
      
      pluginSystem.registerPlugin('plugin2', plugin2);
      pluginSystem.registerPlugin('plugin1', plugin1);
      
      await pluginSystem.initializePlugins();
      
      assert.deepStrictEqual(initOrder, ['plugin1', 'plugin2']);
    });

    it('循環依存がある場合にエラーが発生すること', async () => {
      const plugin1 = {
        name: 'plugin1',
        dependencies: ['plugin2'],
        initialize: async () => {}
      };
      
      const plugin2 = {
        name: 'plugin2',
        dependencies: ['plugin1'],
        initialize: async () => {}
      };
      
      pluginSystem.registerPlugin('plugin1', plugin1);
      pluginSystem.registerPlugin('plugin2', plugin2);
      
      try {
        await pluginSystem.initializePlugins();
        assert.fail('循環依存エラーが発生するはずです');
      } catch (error) {
        assert.ok(error.message.includes('循環依存'));
      }
    });
  });
});