const { expect } = require('chai');
const axios = require('axios');
require('dotenv').config();

// Railway設定の定数
const PROJECT_ID = process.env.RAILWAY_PROJECT_ID || 'fc1f7055-4259-4ab3-a455-7481cf981884';
const SERVICE_ID = process.env.RAILWAY_SERVICE_ID || '0cda408a-9799-4586-a162-90b1056ced87';
const API_TOKEN = process.env.RAILWAY_API_TOKEN;

// Railway APIのベースURL
const RAILWAY_API_BASE = 'https://backboard.railway.app/api/v2';

describe('Railway MCP設定テスト', () => {
  before(() => {
    // APIトークンが設定されているか確認
    if (!API_TOKEN) {
      throw new Error('RAILWAY_API_TOKENが設定されていません。');
    }
  });

  // プロジェクトIDの有効性をテスト
  it('プロジェクトIDが有効であること', async () => {
    try {
      const response = await axios.get(`${RAILWAY_API_BASE}/projects/${PROJECT_ID}`, {
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`
        }
      });
      expect(response.status).to.equal(200);
    } catch (error) {
      throw new Error(`プロジェクトIDの検証に失敗: ${error.message}`);
    }
  });

  // サービスの存在をテスト
  it('指定されたサービスが存在すること', async () => {
    try {
      const response = await axios.get(`${RAILWAY_API_BASE}/services/${SERVICE_ID}`, {
        headers: {
          'Authorization': `Bearer ${API_TOKEN}`
        }
      });
      expect(response.status).to.equal(200);
    } catch (error) {
      throw new Error(`サービスの検証に失敗: ${error.message}`);
    }
  });

  // 環境変数の設定をテスト
  it('必要な環境変数が設定されていること', () => {
    expect(process.env.RAILWAY_API_TOKEN).to.exist;
    expect(process.env.RAILWAY_PROJECT_ID).to.exist;
    expect(process.env.RAILWAY_SERVICE_ID).to.exist;
  });
}); 