/**
 * noobDB E2E テスト設定 — tauri-driver + WebDriverIO (PoC)
 *
 * 【概要】
 * tauri-driver は WebDriver プロトコルのプロキシとして動作し、各プラットフォーム固有の
 * ネイティブ WebDriver に処理を委譲します:
 *   - Linux : WebKitWebDriver (webkit2gtk-driver パッケージ)
 *   - Windows: msedgedriver (Edge/WebView2 付属)
 *
 * これにより、Chromium ベースの Phase 2 では検証できない「実 webview」上での
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
 * この設定は nightly (.github/workflows/e2e.yml、#1245) で使う。CI の必須チェックには
 * 含めていない。詳細は .claude/skills/noobdb-testing/references/e2e.md を参照。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser } from "@wdio/globals";
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
    timeout: 180_000,
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
        // @wdio/tauri-service 1.3 は driverProvider 未指定だと組み込み WebDriver
        // (tauri-plugin-wdio-webdriver) を既定にし、tauri-driver を使わない。本アプリは
        // そのプラグインを登録していないため、外部の tauri-driver を使うことを明示する。
        driverProvider: "external",
      },
    ],
  ],

  // 失敗時のスクリーンショットを e2e/screenshots/ へ保存する (CI がアーティファクトとして回収)。
  afterTest: async (test, _context, { passed }) => {
    if (passed) return;
    const dir = path.resolve(__dirname, "screenshots");
    fs.mkdirSync(dir, { recursive: true });
    const name = test.title.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 80);
    await browser.saveScreenshot(path.join(dir, `${name}.png`));
  },

  // ──────────────────────────────────────────────────────────────────────────
  // ログ
  // ──────────────────────────────────────────────────────────────────────────
  logLevel: "info",
};
