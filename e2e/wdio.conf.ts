/**
 * noobDB E2E テスト設定 — tauri-driver + WebDriverIO (#529 PoC)
 *
 * 【概要】
 * tauri-driver は WebDriver プロトコルのプロキシとして動作し、各プラットフォーム固有の
 * ネイティブ WebDriver に処理を委譲します:
 *   - Linux : WebKitWebDriver (webkit2gtk-driver パッケージ)
 *   - Windows: msedgedriver (Edge/WebView2 付属)
 *
 * これにより、Chromium ベースの Phase 2 (#306) では検証できない「実 webview」上での
 * IPC 通信・レンダリングをエンドツーエンドで検証できます。
 *
 * 【前提条件】
 *   Rust / Cargo の導入 (tauri-driver インストールに必要)
 *     cargo install tauri-driver --locked
 *   Linux 追加パッケージ:
 *     sudo apt-get install -y webkit2gtk-driver xvfb
 *   アプリのデバッグバイナリを事前にビルドしておくこと:
 *     cd src-tauri && cargo build
 *
 * 【実行方法】
 *   # Linux (ヘッドレス環境):
 *   xvfb-run -a pnpm test:e2e
 *   # Linux (ディスプレイあり) / Windows:
 *   pnpm test:e2e
 *
 * 【注意】
 * この設定は PoC・手動運用を前提としており、CI の必須チェックには含めていません。
 * 常設 E2E への昇格は安定性評価後に判断します (詳細は CLAUDE.md の Phase 3 節を参照)。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "@wdio/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// プラットフォームごとのアプリバイナリパス。
// 実行前に `cargo build` または `pnpm tauri build --debug` でビルドしておくこと。
const APP_BINARY =
  process.platform === "win32"
    ? path.resolve(
        __dirname,
        "../src-tauri/target/debug/noobdb.exe",
      )
    : path.resolve(
        __dirname,
        "../src-tauri/target/debug/noobdb",
      );

export const config: Options.Testrunner = {
  // ──────────────────────────────────────────────────────────────────────────
  // ランナー設定
  // ──────────────────────────────────────────────────────────────────────────
  runner: "local",
  autoCompileOpts: {
    autoCompile: true,
    tsNodeOpts: {
      transpileOnly: true,
      project: path.resolve(__dirname, "tsconfig.e2e.json"),
    },
  },

  // ──────────────────────────────────────────────────────────────────────────
  // テスト対象ファイル
  // ──────────────────────────────────────────────────────────────────────────
  specs: ["./specs/**/*.e2e.ts"],
  exclude: [],

  // ──────────────────────────────────────────────────────────────────────────
  // capabilites (プラットフォーム共通)
  // ──────────────────────────────────────────────────────────────────────────
  capabilities: [
    {
      // tauri-driver が WebDriver の "browser" 識別子として要求するキー。
      // "linux" | "windows" を platformName に指定する。
      platformName: process.platform === "win32" ? "windows" : "linux",
      "tauri:options": {
        application: APP_BINARY,
      },
    },
  ],

  // ──────────────────────────────────────────────────────────────────────────
  // タイムアウト (アプリ起動待ちが長い場合に備え大きめに設定)
  // ──────────────────────────────────────────────────────────────────────────
  waitforTimeout: 30_000,
  connectionRetryTimeout: 90_000,
  connectionRetryCount: 3,

  // ──────────────────────────────────────────────────────────────────────────
  // フレームワーク / サービス / レポータ
  // ──────────────────────────────────────────────────────────────────────────
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
  reporters: ["spec"],

  // tauri サービス: tauri-driver の起動/終了、能力のマッピングを自動化する。
  // autoInstallTauriDriver: true にすると cargo 経由で自動インストールを試みる。
  services: [
    [
      "tauri",
      {
        // CI では PATH に tauri-driver が必要 (cargo install tauri-driver --locked)。
        // ローカルでは `~/.cargo/bin/tauri-driver` があれば自動検出される。
        autoInstallTauriDriver: false,
      },
    ],
  ],

  // ──────────────────────────────────────────────────────────────────────────
  // ログ
  // ──────────────────────────────────────────────────────────────────────────
  logLevel: "info",
};
