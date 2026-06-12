/**
 * E2E ハッピーパス: SQLite 接続 → クエリ実行 → ResultGrid 表示 (PoC)
 *
 * このスペックは tauri-driver + WebDriverIO により実 webview (Linux: WebKitGTK /
 * Windows: WebView2) 上で noobDB を駆動し、以下のフローを E2E で検証します:
 *
 *   1. アプリ起動 → 接続リスト (ConnectionList) の表示確認
 *   2. 新規接続フォームを開き SQLite (インメモリ) の接続情報を入力・保存
 *   3. 接続ボタンをクリックしてセッションを確立
 *   4. クエリエディタに SELECT 文を入力して実行
 *   5. ResultGrid に行が表示されることを確認
 *
 * 【前提条件】
 *   - src-tauri/target/debug/noobdb バイナリが存在すること
 *     (`cargo build` または `pnpm tauri build --debug`)
 *   - Linux ではヘッドレス実行に xvfb が必要
 *     (`xvfb-run -a pnpm test:e2e`)
 *
 * 【PoC の限界】
 *   - セレクタはアクセシビリティロール / ラベル優先。data-testid が無い要素は
 *     role + テキストで特定しているため、UI の大幅変更で壊れる可能性がある。
 *   - 実際にビルド済みバイナリが存在しない環境では全テストが skip される。
 *   - Windows WebView2 は未検証 (CI は Linux のみ対象)。
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { browser, $ } from "@wdio/globals";

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

describeMaybe("SQLite ハッピーパス E2E (#529 PoC)", () => {
  // テスト用一時ディレクトリと SQLite ファイルパス。終了後に削除する。
  let tmpDir: string;
  let tmpDbPath: string;

  before(async () => {
    // SQLite インメモリ接続でも良いが、ファイルパスの方がフォーム入力が確実。
    // 予測可能な名前で共有 temp 直下にファイルを作るのは安全でない
    // (シンボリックリンク攻撃・先回り作成のリスク) ため、mkdtemp で 0700 権限の
    // 専用ディレクトリをアトミックに切り、その中に DB ファイルを置く。
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "noobdb-e2e-"));
    tmpDbPath = path.join(tmpDir, "test.db");
    // 接続前に空の DB ファイルを実体として作成しておく
    // (UI 契約上ファイルの存在を前提とする接続経路に備える)。
    fs.writeFileSync(tmpDbPath, "");

    // アプリ起動後のウィンドウ描画を待機する。
    // tauri-driver は app 起動と WebDriver セッション確立を自動で行う。
    // 最初の描画完了まで待つ (body 要素の出現を確認)。
    await browser.pause(1_000);
  });

  after(async () => {
    // テスト用一時ディレクトリごと削除。
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ステップ 1: アプリが起動し ConnectionList が表示されること
  // ──────────────────────────────────────────────────────────────────────────
  it("アプリ起動後に接続リストが表示される", async () => {
    // ConnectionList の「新規接続」ボタン (role=button) を探す。
    // セレクタは src/components/ConnectionList.tsx の aria-label に依存。
    // 表示されるまで最大 20 秒待機する (webview 初期化に時間がかかる場合がある)。
    const newConnectionBtn = await $(
      '[aria-label="New connection"], [aria-label="新規接続"], button*=New, button*=新規',
    );
    await newConnectionBtn.waitForExist({ timeout: 20_000 });
    await expect(newConnectionBtn).toBeDisplayed();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ステップ 2: 新規接続フォームを開き SQLite の設定を入力
  // ──────────────────────────────────────────────────────────────────────────
  it("SQLite 接続フォームに設定を入力して保存できる", async () => {
    // 「新規接続」ボタンをクリックしてフォームを開く。
    const newConnectionBtn = await $(
      '[aria-label="New connection"], [aria-label="新規接続"]',
    );
    await newConnectionBtn.click();

    // フォームが表示されるまで待機。
    // ConnectionForm は接続名の input を持つ。
    const nameInput = await $('input[placeholder*="My DB"], input[placeholder*="例: My DB"]');
    await nameInput.waitForExist({ timeout: 10_000 });

    // 接続名を入力。
    await nameInput.setValue("E2E Test SQLite");

    // ドライバを SQLite に変更。
    const driverSelect = await $("select");
    await driverSelect.selectByAttribute("value", "sqlite");

    // ファイルパスを入力 (一時ファイルパスを使用)。
    // SQLite 選択後にファイルパス input が現れる。
    const filePathInput = await $(
      'input[placeholder*="/home"], input[placeholder*="C:\\\\"]',
    );
    await filePathInput.waitForExist({ timeout: 5_000 });
    await filePathInput.setValue(tmpDbPath);

    // 「保存」ボタンをクリック。
    // ConnectionForm の保存ボタンは type=submit か role=button で "Save" / "保存"。
    const saveBtn = await $('button[type="submit"], button*=Save, button*=保存');
    await saveBtn.click();

    // 保存後は ConnectionList に戻り、追加したプロファイル名が表示される。
    const profileName = await $("*=E2E Test SQLite");
    await profileName.waitForExist({ timeout: 10_000 });
    await expect(profileName).toBeDisplayed();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ステップ 3: 接続を確立する
  // ──────────────────────────────────────────────────────────────────────────
  it("SQLite データベースへ接続できる", async () => {
    // プロファイルをダブルクリックまたは「接続」ボタンをクリック。
    // ConnectionList では接続名をクリックすると「接続」アクションが発火する想定。
    const profileItem = await $("*=E2E Test SQLite");
    await profileItem.click();

    // 「接続」ボタンが出れば押す (右クリックメニュー → Connect など UI により異なる)。
    // まずは "Connect" ボタンまたは同等の要素を探す。
    const connectBtn = await $(
      'button*=Connect, button*=接続, [aria-label*="Connect"], [aria-label*="接続"]',
    );
    // connectBtn が存在すればクリック (プロファイルクリックだけで接続する場合は不要)。
    if (await connectBtn.isExisting()) {
      await connectBtn.click();
    }

    // 接続が確立されると QueryEditor またはタブが表示される。
    // タブバー (TabBar) またはクエリエディタの textarea/div が現れるまで待機。
    const queryArea = await $(
      '[role="textbox"], textarea, .cm-content, [data-testid="query-editor"]',
    );
    await queryArea.waitForExist({ timeout: 30_000 });
    await expect(queryArea).toBeDisplayed();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // ステップ 4: クエリを実行し ResultGrid に結果が表示されること
  // ──────────────────────────────────────────────────────────────────────────
  it("SELECT クエリを実行して ResultGrid に行が表示される", async () => {
    // テーブルを作成し、データを INSERT してから SELECT する。
    // SQLite インメモリ/ファイルDB のためテーブルは存在しないことを前提にする。
    const createSql =
      "CREATE TABLE IF NOT EXISTS e2e_test (id INTEGER PRIMARY KEY, name TEXT);" +
      "INSERT INTO e2e_test (name) VALUES ('hello from e2e');";

    // CodeMirror エディタへの入力: .cm-content に値をセット。
    const editor = await $(".cm-content");
    await editor.waitForExist({ timeout: 10_000 });
    await editor.click();
    // CodeMirror はカーソルキーが必要な場合もあるが、まず Ctrl+A で全選択して上書き。
    await browser.keys(["Control", "a"]);
    await browser.keys([createSql]);

    // 実行ボタン (Run / 実行) をクリック。
    const runBtn = await $(
      'button[aria-label*="Run"], button[aria-label*="実行"], button*=Run, button*=実行',
    );
    await runBtn.waitForExist({ timeout: 5_000 });
    await runBtn.click();

    // CREATE/INSERT の完了後、SELECT を実行。
    await browser.pause(500);

    // エディタの内容を SELECT に切り替える。
    await editor.click();
    await browser.keys(["Control", "a"]);
    await browser.keys(["SELECT * FROM e2e_test;"]);

    // 再実行。
    await runBtn.click();

    // ResultGrid に行が現れるまで待機 (role=row または role=gridcell)。
    const firstRow = await $('[role="row"]:nth-child(2), [role="gridcell"]');
    await firstRow.waitForExist({ timeout: 30_000 });
    await expect(firstRow).toBeDisplayed();

    // "hello from e2e" が表示されていることを確認。
    const cellText = await $("*=hello from e2e");
    await cellText.waitForExist({ timeout: 10_000 });
    await expect(cellText).toBeDisplayed();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (オプション) ステップ 5: セル編集 Apply
  // セル編集は UI インタラクションが複雑で PoC 段階では骨格のみ示す。
  // ──────────────────────────────────────────────────────────────────────────
  it.skip("セルをダブルクリックして内容を編集し Apply できる (骨格のみ)", async () => {
    // ResultGrid のセルをダブルクリックして編集モードに入る。
    const cell = await $('[role="gridcell"]');
    await cell.doubleClick();

    // 編集用 input が現れる。
    const editInput = await $('[role="gridcell"] input');
    await editInput.waitForExist({ timeout: 5_000 });
    await editInput.clearValue();
    await editInput.setValue("updated by e2e");

    // Apply ボタン (aria-label="Apply" など) をクリック。
    const applyBtn = await $('[aria-label*="Apply"], button*=Apply, button*=適用');
    await applyBtn.click();

    // 更新後の値が表示されることを確認。
    const updatedCell = await $("*=updated by e2e");
    await updatedCell.waitForExist({ timeout: 10_000 });
    await expect(updatedCell).toBeDisplayed();
  });
});
