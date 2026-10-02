/**
 * E2E ハッピーパス: SQLite 接続 → 書き込み → 読み出し → 永続確認 (#529 / #1245)
 *
 * tauri-driver + WebDriverIO により実 webview (Linux: WebKitGTK / Windows: WebView2)
 * 上で noobDB を駆動し、次のフローを検証します。
 *
 *   1. 接続が 0 件の初期状態から「最初の接続を作成」を開く
 *   2. SQLite (一時ファイル) の接続情報を入力して保存
 *   3. プロファイルをクリックして接続を確立 (実 IPC + 実 SQLite)
 *   4. CREATE TABLE / INSERT を実行し、集計 SELECT の結果をグリッドで確認
 *   5. IPC 固有の検証: 実エンジンの sqlite_version() が返ること、書き込みが
 *      一時ファイルへ実際に永続化されていること (Node 側で SQLite ヘッダを確認)
 *
 * 【セレクタ方針】
 *   ロケール (ja / en) や文言変更に依存しないよう `data-testid` のみで要素を特定する。
 *   testid は E2E 専用の属性で、見た目・挙動には影響しない。
 *
 * 【前提条件】
 *   - src-tauri/target/debug/noobdb バイナリ (`cargo build`) と dist/ (`pnpm run build`)
 *   - Linux ではヘッドレス実行に xvfb が必要 (`xvfb-run -a pnpm test:e2e`)
 *   - バイナリが無い環境では全テストが skip される
 *   - アプリは既定のプロファイルストアを使うため、接続 0 件の環境 (CI) を前提にする
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { browser, $, $$ } from "@wdio/globals";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ビルド済みバイナリが存在するかチェック。存在しない場合は全テストを skip する。
const binaryPath =
  process.platform === "win32"
    ? path.resolve(__dirname, "../../src-tauri/target/debug/noobdb.exe")
    : path.resolve(__dirname, "../../src-tauri/target/debug/noobdb");

const binaryExists = fs.existsSync(binaryPath);

/**
 * 条件付き describe — バイナリが存在する環境でのみ実テストを走らせる。
 * CI では事前に `cargo build` で生成するか、バイナリが無い場合にスキップする。
 */
const describeMaybe = binaryExists ? describe : describe.skip;

describeMaybe("SQLite ハッピーパス E2E (#1245)", () => {
  // テスト用一時ディレクトリと SQLite ファイルパス。終了後に削除する。
  let tmpDir: string;
  let tmpDbPath: string;

  /** testid でグリッドの全セル文字列を取る。 */
  const gridCellTexts = async (): Promise<string[]> => {
    const cells = await $$('[data-testid="result-grid"] td[role="gridcell"]');
    return Promise.all(cells.map((c) => c.getText()));
  };

  /** エディタを全置換して実行ボタンを押す。 */
  const runSql = async (sql: string) => {
    const editor = await $('[data-testid="query-editor"] .cm-content');
    await editor.waitForExist({ timeout: 10_000 });
    await editor.click();
    await browser.keys(["Control", "a"]);
    await browser.keys([sql]);
    const runBtn = await $('[data-testid="query-editor-run"]');
    await runBtn.waitForEnabled({ timeout: 10_000 });
    await runBtn.click();
  };

  before(async () => {
    // 予測可能な名前で共有 temp 直下にファイルを作るのは安全でないため、
    // mkdtemp で 0700 権限の専用ディレクトリをアトミックに切り、その中に DB を置く。
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "noobdb-e2e-"));
    tmpDbPath = path.join(tmpDir, "test.db");
    // SQLite は 0 バイトのファイルを空 DB として開ける。
    fs.writeFileSync(tmpDbPath, "");
  });

  after(async () => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("接続 0 件の初期状態で「最初の接続を作成」が表示される", async () => {
    const createFirst = await $('[data-testid="connection-create-first"]');
    await createFirst.waitForExist({ timeout: 30_000 });
    await expect(createFirst).toBeDisplayed();
  });

  it("SQLite 接続フォームに設定を入力して保存できる", async () => {
    await (await $('[data-testid="connection-create-first"]')).click();

    const nameInput = await $('[data-testid="connection-form-name"]');
    await nameInput.waitForExist({ timeout: 10_000 });
    await nameInput.setValue("E2E Test SQLite");

    await (await $('[data-testid="connection-form-driver"]')).selectByAttribute("value", "sqlite");

    const filePathInput = await $('[data-testid="connection-form-sqlite-path"]');
    await filePathInput.waitForExist({ timeout: 5_000 });
    await filePathInput.setValue(tmpDbPath);

    await (await $('[data-testid="connection-form-save"]')).click();

    const row = await $('[data-testid="connection-profile-row"]');
    await row.waitForExist({ timeout: 10_000 });
    await expect(row).toHaveAttribute("data-profile-name", "E2E Test SQLite");
  });

  it("SQLite データベースへ接続できる (実 IPC)", async () => {
    await (await $('[data-testid="connection-profile-row"]')).click();
    const editor = await $('[data-testid="query-editor"]');
    await editor.waitForExist({ timeout: 30_000 });
    await expect(editor).toBeDisplayed();
  });

  it("書き込み (CREATE / INSERT) を実行し、集計結果が実 SQLite から返る", async () => {
    await runSql("CREATE TABLE e2e_items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)");
    await runSql(
      "INSERT INTO e2e_items (name, qty) VALUES ('alpha', 3), ('beta', 4), ('gamma', 5)",
    );
    await runSql("SELECT count(*) AS n, sum(qty) AS total FROM e2e_items");

    // 3 行 / 合計 12 が結果グリッドに出る (実 IPC → 実 SQLite → ストリーミング結果)。
    await browser.waitUntil(async () => {
      const texts = await gridCellTexts();
      return texts.includes("3") && texts.includes("12");
    }, { timeout: 30_000, timeoutMsg: "集計結果 (3 / 12) がグリッドに表示されなかった" });
  });

  // IPC 固有のアサーション: Chromium ブラウザモード (invoke スタブ) では
  // 実エンジンの応答もディスクへの永続化も検証できない。
  it("実エンジンの sqlite_version() が返り、書き込みが一時ファイルへ永続化されている", async () => {
    await runSql("SELECT sqlite_version() AS v");
    await browser.waitUntil(async () => {
      const texts = await gridCellTexts();
      return texts.some((t) => /^\d+\.\d+\.\d+/.test(t));
    }, { timeout: 30_000, timeoutMsg: "sqlite_version() の値 (x.y.z) がグリッドに表示されなかった" });

    // Node 側でファイルを直接確認する: 空 (0 バイト) だった DB に SQLite ヘッダと
    // 書き込んだ行が実在する。
    const stat = fs.statSync(tmpDbPath);
    expect(stat.size).toBeGreaterThan(0);
    const bytes = fs.readFileSync(tmpDbPath);
    expect(bytes.subarray(0, 15).toString("latin1")).toBe("SQLite format 3");
    // 既定はロールバックジャーナルだが、WAL 運用でも落ちないよう -wal も連結して探す。
    const walPath = `${tmpDbPath}-wal`;
    const all = fs.existsSync(walPath) ? Buffer.concat([bytes, fs.readFileSync(walPath)]) : bytes;
    expect(all.includes(Buffer.from("e2e_items"))).toBe(true);
    expect(all.includes(Buffer.from("gamma"))).toBe(true);
  });
});
