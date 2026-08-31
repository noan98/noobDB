# Phase 3: tauri-driver による実 webview E2E 基盤 (#529 PoC)

## Phase 3: tauri-driver による実 webview E2E 基盤 (#529 PoC)

**位置づけ**: Phase 2 (#306) の Chromium ブラウザモードは「Web 層のレイアウト/ビジュアル
退行」を検出するが、Tauri が実際に使う webview (Linux: WebKitGTK / Windows: WebView2)
上での **実 IPC 通信込みのエンドツーエンド動作**は検証できない。Phase 3 はその補完として
`tauri-driver` + `WebDriverIO` により実 webview を WebDriver プロトコル経由で駆動する
基盤の PoC であり、#529 で実現可能性を評価した。

## 構成ファイル

| ファイル | 役割 |
|---|---|
| `e2e/wdio.conf.ts` | WebDriverIO の設定。`@wdio/tauri-service` を使い tauri-driver の起動/終了を自動化。アプリバイナリパスをプラットフォーム別に解決する |
| `e2e/tsconfig.e2e.json` | E2E 専用 tsconfig (主 tsconfig.json の対象外として分離し tsc エラーを防ぐ) |
| `e2e/specs/sqlite-happy-path.e2e.ts` | SQLite ハッピーパスのスペック。接続フォーム入力 → 接続確立 → SELECT 実行 → ResultGrid 表示 → セル編集 Apply (骨格) の 5 ステップ |
| `.github/workflows/e2e.yml` | `workflow_dispatch` 手動トリガの CI ワークフロー。Linux (Ubuntu 22.04) 上で `webkit2gtk-driver` + `xvfb` + `tauri-driver` を使う |

## ローカル実行手順

```sh
# 1. tauri-driver をインストール (初回のみ)
cargo install tauri-driver --locked

# 2. Linux 追加パッケージ
sudo apt-get install -y webkit2gtk-driver xvfb

# 3. Tauri デバッグバイナリをビルド (初回 + Rust ソース変更時)
cd src-tauri && cargo build && cd ..

# 4. フロントエンドをビルド (dist/ を生成)
pnpm run build

# 5. E2E 実行 (Linux ヘッドレス)
xvfb-run -a pnpm test:e2e
# E2E 実行 (Linux ディスプレイあり / Windows)
pnpm test:e2e
```

## #306 (Chromium) との違い・補完関係

| 観点 | Phase 2 (Chromium, #306) | Phase 3 (tauri-driver, #529) |
|---|---|---|
| 検証エンジン | headless Chromium (Playwright provider) | 実 WebKitGTK / WebView2 |
| Tauri IPC | スタブ (invoke を無害化) | **実 IPC** を駆動 |
| DB 接続 | 不要 (props 注入) | **実 SQLite** 接続を確立 |
| 検証対象 | UI レンダリング・CSS・レイアウト | IPC ラウンドトリップ・DB 動作 |
| 実行速度 | 数十秒 (Chromium 起動) | 数分〜 (Tauri バイナリビルド含む) |
| 安定性 | 高 (Chromium は成熟) | 中〜低 (WebKitGTK + xvfb は flaky になりやすい) |

Phase 2 がレイアウト/ビジュアルの退行検出に強く、Phase 3 が IPC を含む実動作の
エンドツーエンド検証に強い。両者は補完関係であり、競合しない。

## 実現可能性の評価 (#529 実施時点)

- **技術的実現性**: `tauri-driver` + `@wdio/tauri-service` の組み合わせは公式に
  サポートされており、構成ファイルの整備は完了できた。
- **実行時間**: Rust デバッグバイナリのクリーンビルドで 10〜20 分、キャッシュ有りで
  4〜8 分程度。これに E2E テスト自体の 2〜5 分が加わり、PR ごとのゲートとして使うには
  コストが高い。
- **安定性 (flaky リスク)**: WebKitWebDriver + xvfb の組み合わせはウィンドウ描画タイミング・
  GTK 初期化順序に依存し、タイムアウトによる flaky が起きやすい。セレクタを
  role/text ベースで書いているため UI 変更で壊れるリスクもある。
- **メンテコスト**: tauri-driver は Tauri のバージョンに追従が必要。WebDriverIO
  のバージョン (`@wdio/tauri-service@1.0.0` は WebDriverIO v9 が必要) の固定管理も
  必要。
- **macOS 非対応**: WKWebView に WebDriver 実装がなく、tauri-driver は macOS を
  サポートしない (Linux / Windows のみ)。

## CI 適用方針の結論

**方針: `workflow_dispatch` 手動トリガで PoC 運用。安定化後に nightly を検討。**

現時点での必須チェック化は行わない。理由:

1. **ビルド時間**: Tauri バイナリのビルドが PR ゲートを大幅に延ばし、#443/#482 の
   「漸進的品質向上」方針に反する (現在の CI 壁時計時間を倍増させるリスク)。
2. **flaky リスク**: WebKitWebDriver + xvfb は安定実績が浅く、false negative で
   マージをブロックし続ける運用負荷が大きい。
3. **補完対象が限定的**: 現在の E2E スペック (SQLite ハッピーパス 1 本) は
   Phase 2 が既にカバーする範囲と重複しており、差分の価値がまだ低い。

**nightly への昇格基準** (以下が揃ったら `schedule: cron` で週次に昇格を検討):
- テストが 3 回連続で安定してグリーンになること
- 実行時間が 15 分以内に収まること (キャッシュ暖機後)
- セレクタを `data-testid` で安定化させること (Phase 3 専用 testid を最小限追加)
- IPC 固有のアサーション (Chromium では検証不可なもの) が 1 件以上追加されること

コスト: High (Tauri ビルド + flaky 管理) / メリット: 3 (実 webview 検証は価値あるが
Phase 2 との差分は当面限定的) — まず PoC 運用で安定性を評価し、メリットが確認できた
段階で昇格する。
