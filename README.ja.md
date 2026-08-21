# pgroonga-mcp

[English README](README.md)

[Model Context Protocol](https://modelcontextprotocol.io/)経由で、PostgreSQLとPGroongaの検索・診断を読み取り専用で提供するMCPサーバーです。インストール済みのPGroongaスキーマと機能を検出し、PostgreSQLカタログから検索対象を解決し、検索条件とフィルター値をパラメーターとしてバインドします。

任意のSQL、`pgroonga_command`、DDL、辞書の変更、修復操作は公開しません。

## 要件

- Node.js 22以上
- PGroonga拡張をインストールしたPostgreSQL
- スーパーユーザーでも`BYPASSRLS`でもない専用PostgreSQLロール
- ローカルstdioサーバーに対応したMCPホスト

npmパッケージはMCPサーバーとプロジェクト設定コマンドを提供します。PostgreSQLやPGroonga自体はインストールしません。

## インストール

プロジェクトへインストールします。

```sh
npm i @askdkc/pgroonga-mcp
```

グローバルへインストールする場合は以下を実行します。

```sh
npm i --global @askdkc/pgroonga-mcp
pgroonga-mcp
```

データベースURLがなくても起動できます。MCPホストやAIエージェントからツール一覧を確認したり、SQL生成ワークフローを利用したりできます。PostgreSQL URLを設定するまで、データベースを使うツールは構造化された`database_unavailable`エラーを返します。

サーバーはstdin/stdoutで通信し、MCPプロトコルのストリームを壊さないようログはstderrへ出力します。

## プロジェクトのセットアップ

パッケージをインストールした後、セットアップコマンドを実行してMCPクライアントのプロジェクト設定を作成します。

```sh
npm i @askdkc/pgroonga-mcp
npx pgroonga-mcp setup
```

対話式の選択画面で、Codex、Claude Code、OpenCode、DSH（DeepSeek Harness）から利用するクライアントを選択できます。セットアップはプロジェクト内の設定ファイルだけを変更し、ユーザーのグローバル設定やデータベース認証情報は変更・追加しません。

生成されるMCPサーバーの起動コマンドは、MCP起動時にネットワークからパッケージをダウンロードしない形式です。

```text
npx --no-install pgroonga-mcp
```

CIやスクリプトではフラグで選択できます。

```sh
# 対応しているすべてのクライアントを設定
npx pgroonga-mcp setup --all

# クライアントを選択して設定
npx pgroonga-mcp setup --clients codex,claude,opencode

# ファイルを変更せず、変更内容だけを確認
npx pgroonga-mcp setup --all --dry-run

# 既存のpgroonga設定を確認した上で置き換え
npx pgroonga-mcp setup --clients claude --force
```

セットアップで作成または更新されるプロジェクト設定は次のとおりです。

| クライアント | ファイル                                      |
| ------------ | --------------------------------------------- |
| Codex        | `.codex/config.toml`                          |
| Claude Code  | `.mcp.json`                                   |
| OpenCode     | `opencode.json`、または既存の`opencode.jsonc` |
| DSH          | `cordis.yml`                                  |

対象外の設定は保持します。選択したファイルに異なる`pgroonga`エントリが存在する場合、上書きせずに停止します。既存設定を確認してから`--force`を使用してください。既存の`opencode.jsonc`を更新すると、JSONCのコメントは正規化される場合があります。セットアップ後は対象クライアントを再起動してください。Claude Codeではプロジェクトスコープの`.mcp.json`サーバーを承認する確認が表示される場合があります。

セットアップコマンドはNode.jsのファイルシステムAPIとプロジェクト相対パスだけを使用します。macOS、Linux、Windows上のWSLで利用できます。WSLではWSL内にインストールしたNode.js/npmを使い、WSLから参照できるプロジェクトディレクトリで実行してください。

## MCPホストの手動設定

MCPホストごとに設定ファイルの形式が異なります。一般的なstdio設定は次のとおりです。

```json
{
  "mcpServers": {
    "pgroonga": {
      "command": "npx",
      "args": ["--yes", "@askdkc/pgroonga-mcp"],
      "env": {
        "PGROONGA_DATABASE_URL": "postgresql://pgroonga_mcp@127.0.0.1:5432/app",
        "PGROONGA_ALLOWED_SCHEMAS": "public",
        "PGROONGA_ALLOWED_TABLES": "public.documents"
      }
    }
  }
}
```

npmパッケージ名は`@askdkc/pgroonga-mcp`ですが、インストールされる実行ファイル名は`pgroonga-mcp`です。グローバルインストール済みの場合は`npx`ではなく実行ファイルを使用してください。コミットする設定ファイルへデータベースパスワードを書かず、MCPホストの環境変数・シークレット機能を使用してください。サーバーはカレントディレクトリの`.env`を読み込みますが、既存のプロセス環境変数は上書きしません。プロジェクトの環境ファイルが別の場所にある場合は`PGROONGA_ENV_FILE`を設定してください。

## データベース権限

最小権限のロールを使用してください。スキーマ、テーブル、PGroonga拡張スキーマはデプロイ環境に合わせて置き換えます。

```sql
CREATE ROLE pgroonga_mcp LOGIN PASSWORD 'use-a-secret-manager';
GRANT CONNECT ON DATABASE app TO pgroonga_mcp;
GRANT USAGE ON SCHEMA public, extensions TO pgroonga_mcp;
GRANT SELECT ON TABLE public.documents TO pgroonga_mcp;
```

設定済みインデックスで使用するNormalizerTableの辞書テーブルにも`SELECT`を付与してください。`SUPERUSER`、`BYPASSRLS`、アプリケーションスキーマへの`CREATE`は付与しないでください。行レベルセキュリティポリシーは有効なままにしてください。各操作は`row_security = on`の読み取り専用トランザクションで実行されます。

## 設定

すべての設定は環境変数で指定します。`PGROONGA_DATABASE_URL`は任意です。未設定の場合、`DATABASE_URL`、`POSTGRES_URL`、`POSTGRESQL_URL`にPostgreSQL URLがあれば使用します。PostgreSQL以外の値は無視します。許可スキーマのデフォルトは`public`です。`PGROONGA_ALLOWED_TABLES`が空の場合、許可スキーマ内のすべてのテーブルが対象になるため、本番環境では明示的に設定してください。テーブルは`schema.table`またはテーブル名で指定できます。

| 変数                                     | デフォルト | 説明                                 |
| ---------------------------------------- | ---------: | ------------------------------------ |
| `PGROONGA_DATABASE_URL`                  |          — | 任意のPostgreSQL接続URL              |
| `PGROONGA_ENV_FILE`                      |     `.env` | 読み込むプロジェクト環境ファイル     |
| `PGROONGA_ALLOWED_SCHEMAS`               |   `public` | カンマ区切りのスキーマ許可リスト     |
| `PGROONGA_ALLOWED_TABLES`                |         空 | カンマ区切りのテーブル許可リスト     |
| `PGROONGA_STATEMENT_TIMEOUT_MS`          |     `5000` | PostgreSQLステートメントタイムアウト |
| `PGROONGA_LOCK_TIMEOUT_MS`               |     `1000` | PostgreSQLロックタイムアウト         |
| `PGROONGA_DEFAULT_LIMIT`                 |       `20` | 検索結果のデフォルト行数             |
| `PGROONGA_MAX_ROWS`                      |      `100` | 検索結果の最大行数                   |
| `PGROONGA_MAX_RESPONSE_BYTES`            |  `1048576` | シリアライズ済みレスポンスの上限     |
| `PGROONGA_MAX_TEXT_BYTES`                |   `131072` | 結果中の文字列ごとの上限             |
| `PGROONGA_MAX_NORMALIZATION_INPUT_BYTES` |    `16384` | 正規化入力の上限                     |
| `PGROONGA_MAX_VARIANTS`                  |      `500` | 変換候補検索の上限                   |
| `PGROONGA_LOG_LEVEL`                     |     `info` | `debug`、`info`、`warn`、`error`     |
| `PGROONGA_TRANSPORT`                     |    `stdio` | 現在対応しているのは`stdio`のみ      |

完全な開発用サンプルは[.env.example](.env.example)にあります。環境変数サンプルと`examples/itaiji/`のNormalizerTableフィクスチャはnpm tarballに含まれます。

## ツール

- `pgroonga_server_info` — PostgreSQL、PGroonga、Groonga、機能の情報
- `pgroonga_list_indexes` — カタログから解決したPGroongaインデックスと対応モード
- `pgroonga_search` — 構造化フィルター付きの上限付き検索
- `pgroonga_explain_search` — 検証済み検索に対する非実行の`EXPLAIN (FORMAT JSON)`
- `pgroonga_health` — 利用可能なPGroongaヘルスチェック
- `pgroonga_list_normalization_profiles` — 検出したインデックス正規化チェーン
- `pgroonga_normalize_text` — 検出したインデックスプロファイルでのテキスト正規化
- `pgroonga_lookup_variants` — 上限付きNormalizerTable候補検索
- `pgroonga_validate_normalization_profile` — 辞書マッピングを変更せずに検証

`pgroonga_search`の入力例です。

```json
{
  "target": { "schema": "public", "table": "documents", "column": "body" },
  "mode": "keyword",
  "query": "PGroonga",
  "returnColumns": ["id", "body"],
  "limit": 20
}
```

検索対象は、互換性があり有効で準備完了状態のPGroongaインデックスが検出された場合に、`text`、`varchar`、`text[]`、`jsonb`をサポートします。対応モードは`keyword`、`query`、`prefix`、`exact`、`regexp`です。`similar`は将来のリリース用に予約されています。複合、式、部分インデックスはこのリリースでは検出情報のみ提供します。

Normalizerプロファイルは信頼されたインデックスのreloptionsから読み取ります。`NormalizerTable`依存関係は`pgroonga_table_name`経由で解決されます。辞書の変更には`REINDEX`が必要であることを報告し、将来管理されたリビジョンテーブルが導入されるまで辞書の最新性は`unknown`です。必要なsource-locationとsource-offsetオプションがない場合、ハイライトは無効です。

## 開発とリリース確認

```sh
npm ci
npm run verify
npm pack --dry-run
```

`npm run verify`はフォーマット、lint、型検査、ユニット・契約テスト、TypeScriptビルドを実行します。公開前には`prepublishOnly`と`prepack`が関連する検査とビルドを再実行します。npmへ認証し、`npm pack --dry-run`の内容を確認した後、現在のバージョンを公開します。

```sh
npm publish
```

リポジトリは[askdkc/pgroonga-mcp](https://github.com/askdkc/pgroonga-mcp)です。NormalizerTableの小さなフィクスチャは[examples/itaiji/schema.sql](examples/itaiji/schema.sql)にあります。
