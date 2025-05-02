# bocchy-discord-bot

## アップデート履歴（2025年5月）

- **高度な文脈知能・パーソナライズ**：Supabaseスキーマ拡張、ユーザープロファイル・履歴・ベクトル検索による個別最適化応答
- **自己反省・自己修正**：GPT-4o-miniによるBot応答の適切性チェックと自動修正
- **長期記憶・会話要約**：LangChain＋Supabaseで会話全体の要約・話題・感情トーンを保存
- **感情分析**：HuggingFace Transformersによる感情分析（現在は本番環境で一時停止中）
- **運用自動化・MCP監視**：MCP（Model Context Protocol）によるRailway/Supabaseの自動監視・デプロイ・ログ取得
- **GitHub⇔Railway連携の安定化**：mainブランチ再Pushによるデプロイ同期不整合の自動解消

## 概要

**bocchy-discord-bot**は、Discordサーバーで"人間らしい空気読み"と"高度な文脈理解"を実現するAIチャットボットです。

- OpenAI（GPT-4o）による自然な会話応答
- Google検索連携で最新情報も自動取得
- Supabaseで会話履歴や要約を保存し、文脈を維持
- AIによる盛り上がり検知・空気読み介入
- YAMLでキャラクターやプロンプトを柔軟に定義

---

## 特徴
- **AI盛り上がり検知**：会話の流れや雰囲気をAIが解析し、盛り上がり度に応じて自発的に発言
- **Google検索連携**：質問内容に応じてGoogle Custom Search APIで最新情報を取得し、要約＋出典付きで返答
- **短期・長期記憶**：Supabaseに会話履歴や要約を保存し、文脈を維持
- **コマンドレス応答**：メンションやコマンドがなくても自然に会話へ介入
- **拡張性**：YAMLや.envでキャラクター・APIキー・権限管理などを柔軟に設定可能

---

## 導入方法
1. このリポジトリをクローン
2. `.env`ファイルを作成し、必要なAPIキー（OpenAI, Google, Supabase等）を設定
3. `npm install` で依存パッケージをインストール
4. `npm start` でローカル起動、またはGitHub Actions/Railwayで自動デプロイ

---

## 主要ファイル構成
- `src/action-runner.js` … 会話履歴管理・要約・Google検索・AI応答の中核ロジック
- `src/index.js` … Discordボットのエントリーポイント
- `bocchy-character.yaml` … ボットのキャラクター・プロンプト定義
- `supabase/` … DBスキーマ・マイグレーション
- `.github/workflows/` … CI/CD自動デプロイ設定

---

## 技術スタック
- Node.js (ESM/JavaScript)
- discord.js v14
- OpenAI API（GPT-4o, Embedding）
- Supabase（PostgreSQL + pgvector）
- Google Custom Search API
- GitHub Actions（CI/CD）

---

## 拡張ポイント
- embeddingを活用したRAG型ナレッジベースや類似検索
- ルールベース＋AIハイブリッドによる空気読み
- 外部ナレッジベース連携（Notion, Google Drive等）
- 多言語対応やWeb UIの追加

---

## ライセンス
MIT 