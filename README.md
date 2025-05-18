# bocchy-discord-bot

## アップデート履歴（2025年5月）

- **TypeScript＋ESM化・再設計**：全主要ロジックをTypeScript（.ts）＋ESMで再構築、保守性・拡張性を大幅向上
- **コア機能ルールの明文化**：`bocchy_core_rules`に基づくモジュール設計・エラーハンドリング・命名規則・キャッシュ・ストリーミング・コスト最適化を徹底
- **高度な文脈知能・パーソナライズ**：Supabaseスキーマ拡張、ユーザープロファイル・履歴・ベクトル検索による個別最適化応答
- **自己反省・自己修正**：gpt-4.1-nano-2025-04-14によるBot応答の適切性チェックと自動修正
- **長期記憶・会話要約**：LangChain＋Supabaseで会話全体の要約・話題・感情トーンを保存
- **感情分析**：OpenAI API（gpt-4.1-nano-2025-04-14）による感情分析
- **運用自動化・MCP監視**：MCP（Model Context Protocol）によるRailway/Supabaseの自動監視・デプロイ・ログ取得
- **GitHub⇔Railway連携の安定化**：mainブランチ再Pushによるデプロイ同期不整合の自動解消
- **Token消費の大幅削減**：プロンプトは「直近5件＋要約＋相関サマリー＋パーソナライズ情報」のみを圧縮利用、Token消費を常時監視・自動圧縮
- **介入頻度の厳格制御**：明示トリガー・AI判定・確率判定の三段階で自然介入を最小限に
- **プライバシー配慮**：公開チャンネルの情報のみを活用し、DMや非公開情報は一切利用しない
- **CI/CD・テスト基盤の強化**：Vitest＋GitHub Actions＋Railwayで自動テスト・自動デプロイ・運用監視を実現

---

## 概要

**bocchy-discord-bot**は、Discordサーバーで"人間らしい空気読み"と"高度な文脈理解"を実現するAIチャットボットです。

- OpenAI（gpt-4.1-nano-2025-04-14）による自然な会話応答
- Google検索連携で最新情報も自動取得
- Supabaseで会話履歴や要約を保存し、文脈を維持
- AIによる盛り上がり検知・空気読み介入（介入頻度は厳格制御）
- YAML/設定ファイルでキャラクターやプロンプトを柔軟に定義
- Token消費を常時監視・圧縮し、分脈理解とコスト最適化を両立
- パーソナライズ情報・相関ネットワークを活用した個別最適化応答
- CI/CD・MCP連携による自動運用・監視
- 技術仕様や運用方針の詳細は「尋ねられた時のみ」説明（通常はToken節約のため省略）

---

## コア設計思想・ルール（抜粋）
- すべてのコードはモジュール化・再利用性・保守性を最優先
- 単一責任原則・明確な役割分担・依存最小化
- 設定値やルールは`config/rules.js`等で一元管理し、ハードコーディング禁止
- エラーハンドリングは明示的に・適切なメッセージを返す
- 外部APIは`p-queue`でバッチ化・`lru-cache`でキャッシュ・自動リトライ
- Embeddingは`text-embedding-3-small`、ストリーミング応答は10文字ごとに逐次送信
- CI/CD・MCP連携・自動化・安全性を重視し、運用負荷を最小化
- テスト・デバッグ・運用ナレッジは明文化し、誰でも追従できる体制

---

## 主要ファイル構成
- `src/` … 主要ロジック（TypeScript/ESM）
  - `action-runner.ts` … 会話履歴管理・要約・Google検索・AI応答の中核
  - `index.ts` … Discordボットのエントリーポイント
- `config/rules.js` … ルール・設定値の一元管理
- `bocchy-character.yaml` … ボットのキャラクター・プロンプト定義
- `supabase/` … DBスキーマ・マイグレーション
- `.github/workflows/` … CI/CD自動デプロイ設定
- `test/` … Vitestによるテストコード

---

## 導入方法
1. このリポジトリをクローン
2. `.env`ファイルを作成し、必要なAPIキー（OpenAI, Google, Supabase等）を設定
3. `npm install` で依存パッケージをインストール
4. `npm run build` でTypeScriptをビルド
5. `npm start` でローカル起動、またはGitHub Actions/Railwayで自動デプロイ

---

## 運用・CI/CD・MCP連携
- GitHub ActionsでmainブランチPush時に自動テスト・自動デプロイ
- Railway MCPで本番サービス・DB・ログを自動監視
- Supabaseで会話履歴・要約・プロファイル・ベクトルストアを管理
- トラブル時は`fix-mcp-config.ps1`や`update-railway.bat`で再同期
- 詳細な運用ナレッジ・トラブルシューティングは`bocchy-mpc-config`参照

---

## 技術スタック
- Node.js (TypeScript/ESM)
- discord.js v15
- OpenAI API（gpt-4.1-nano-2025-04-14, Embedding）
- Supabase（PostgreSQL + pgvector）
- Google Custom Search API
- GitHub Actions（CI/CD）
- Railway（本番運用・監視）
- Vitest（テスト基盤）

---

## 拡張ポイント
- embeddingを活用したRAG型ナレッジベースや類似検索
- ルールベース＋AIハイブリッドによる空気読み
- 外部ナレッジベース連携（Notion, Google Drive等）
- 多言語対応やWeb UIの追加
- 本番・開発環境の自動切替・監視強化

---

## トラブルシューティング
- `.env`やAPIキーの設定ミスは最初に確認
- GitHub/Railway/Supabaseの連携不整合は`fix-mcp-config.ps1`や`update-railway.bat`で解消
- テスト失敗時はVitestログ・CIログを参照
- 詳細は`bocchy-mpc-config`や運用ナレッジを参照

---

## ライセンス
MIT 