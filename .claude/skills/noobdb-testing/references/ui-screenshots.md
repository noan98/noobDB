# UI の確認方法 (実ブラウザでのスクリーンショット撮影)

UI を変更したとき、または UI の改善点を洗い出すときに、**実ブラウザ (Chromium) 上で
アプリ全体を描画してスクリーンショットを撮り、目視で確認する**手順。Tauri の実機
(`pnpm tauri dev`) はクラウド実行環境では起動できないため、既存の Vitest ブラウザ
モード + フェイク Tauri ランタイム (`tauriMock.ts`) を流用する。

## 必ず守ること

- **キャプチャは必ず日本語画面で撮る。** ブラウザテストの共通セットアップ
  (`setup.browser.ts`) はロケールを英語に固定しているので、撮影用テストの
  `beforeEach` で **`setLocale("ja")` を呼び直す** (共通セットアップの `beforeEach`
  より後に登録されるため上書きできる)。英語のまま撮ったキャプチャは PR や Issue に
  貼らない。
- 撮影用のテスト・設定・PNG は**一時ファイル**。確認が終わったら削除し、コミットに
  含めない (下記のパスは `.gitignore` 済みだが、`*.browser.test.tsx` を残すと
  `pnpm test:browser` の対象に入ってしまう)。
- モックに応答を登録していないコマンドはエラートーストになる。撮りたい画面が呼ぶ
  コマンド (`list_processes` / `list_db_users` など) は `onCommand` で固定応答を
  登録する。未登録のまま「エラーが出る」と報告しない。
- ビューポートは `1280×800` に固定する (既存のビジュアル回帰と同じ)。はみ出し・
  折り返しの判断基準を揃えるため。

## 手順

1. 依存関係を入れる (`pnpm install`)。
2. 撮影用テストを `src/__tests__/browser/ui-audit.browser.test.tsx` に置く
   (テンプレートは下記)。
3. 撮影専用の設定 `vitest.ui-audit.config.ts` をリポジトリ直下に置く (下記)。
   クラウド実行環境では `playwright` が期待する Chromium のビルド番号と同梱の
   Chromium が一致しないため、`launchOptions.executablePath` で
   `/opt/pw-browsers/chromium` を直接指す。ローカル (Playwright を
   `pnpm exec playwright install` 済み) ならこの指定は不要。
4. 実行する。

   ```sh
   pnpm exec vitest run --config vitest.ui-audit.config.ts
   ```

5. PNG は `src/__tests__/browser/__screenshots__/ui-audit/` に出る
   (`page.screenshot({ path })` の相対パスは**テストファイルのあるディレクトリ**基準)。
   Read ツールで開いて目視する。
6. 確認が終わったら 3 つとも削除する。

   ```sh
   rm -rf src/__tests__/browser/ui-audit.browser.test.tsx \
          vitest.ui-audit.config.ts \
          src/__tests__/browser/__screenshots__/ui-audit
   ```

## テンプレート: 撮影用テスト

画面ごとに `it` を分ける (1 つの `it` で全画面を巡回すると、途中の失敗で後続が
撮れない)。`step()` は失敗しても `-FAILED.png` を残して続行する。

```tsx
// src/__tests__/browser/ui-audit.browser.test.tsx
import { beforeEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderInBrowser } from "./render";
import App from "../../App";
import { setLocale, t } from "../../i18n";
import { setTabRestoreMode } from "../../settings";
import { emitChannelMessage, installTauriMock, onCommand, type ChannelLike } from "./tauriMock";
import type { CellValue, ConnectionProfile } from "../../api/tauri";

// テストファイルのディレクトリ基準。src/__tests__/browser/__screenshots__/ui-audit/ に出る。
const DIR = "__screenshots__/ui-audit";
const ALPHA: ConnectionProfile = {
  id: "p-alpha", name: "Alpha DB", driver: "mysql", host: "127.0.0.1", port: 3306, user: "root",
  database: "appdb", ssh: null, group: null, color: null, is_production: false, confirm_writes: false,
  read_only: false, skip_history: false, file_path: null,
};
const COLS = [{ name: "id", type_name: "INT" }, { name: "name", type_name: "VARCHAR" }];
const ROWS: CellValue[][] = [[1, "apple"], [2, "banana"], [3, null]];

beforeEach(() => {
  localStorage.clear();
  installTauriMock();
  setLocale("ja"); // 共通セットアップの英語固定を上書きする (キャプチャは日本語画面で)
  setTabRestoreMode("always");
  onCommand("list_profiles", () => [ALPHA]);
  onCommand("list_snippets", () => []);
  onCommand("list_history", () => []);
  onCommand("list_sandboxes", () => []);
  onCommand("list_tasks", () => []);
  onCommand("connect", () => ({ session_id: "sess-1" }));
  onCommand("disconnect", () => null);
  onCommand("ping_session", () => true);
  onCommand("list_databases", () => ["appdb"]);
  onCommand("list_tables", () => ["fruits"]);
  onCommand("describe_table", () => [
    { name: "id", data_type: "INT", nullable: false, key: "PRI", default: null, extra: "", referenced_table: null, referenced_column: null },
    { name: "name", data_type: "VARCHAR(64)", nullable: true, key: "", default: null, extra: "", referenced_table: null, referenced_column: null },
  ]);
  onCommand("list_indexes", () => []);
  onCommand("schema_overview", () => [{ name: "fruits", columns: ["id", "name"] }]);
  onCommand("foreign_keys", () => []);
  onCommand("table_row_estimates", () => [{ name: "fruits", estimate: 3 }]);
  onCommand("list_schema_objects", () => []);
  onCommand("list_processes", () => []);
  onCommand("cancel_stream", () => ({ cancelled: true, deliveredRows: 1 }));
  onCommand("run_query_stream", (args) => {
    const ch = args.onEvent as ChannelLike;
    window.setTimeout(() => {
      emitChannelMessage(ch, { kind: "columns", columns: COLS });
      emitChannelMessage(ch, { kind: "rows", rows: ROWS });
      emitChannelMessage(ch, { kind: "done", totalRows: ROWS.length, rowsAffected: 0, elapsedMs: 5, hasColumns: true, appliedAutoLimit: null });
    }, 0);
    return null;
  });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function shot(name: string) {
  await wait(700); // トーストやフェードが落ち着くのを待つ
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); await shot(name); }
  catch (e) { console.warn(`[ui-audit] ${name}: ${String(e).slice(0, 200)}`); await shot(`${name}-FAILED`); }
}
async function boot() {
  const screen = await renderInBrowser(<App />);
  await expect.element(screen.getByRole("treeitem", { name: /Alpha DB/ })).toBeVisible();
  await wait(2500); // 起動スプラッシュのフェードアウトを待つ
  return screen;
}
async function connectAndOpen(screen: Awaited<ReturnType<typeof boot>>) {
  await screen.getByRole("treeitem", { name: /Alpha DB/ }).click();
  await expect.element(screen.getByRole("treeitem", { name: "appdb", exact: true })).toBeVisible();
  await screen.getByRole("treeitem", { name: "appdb", exact: true }).click();
  const row = screen.getByRole("treeitem", { name: /fruits/ });
  await expect.element(row).toBeVisible();
  await row.dblClick();
  await expect.element(screen.getByRole("gridcell", { name: "banana", exact: true })).toBeVisible();
}

it("01 未接続", async () => {
  const screen = await boot();
  await shot("01-start");
  await step("02-settings", async () => {
    await screen.getByRole("button", { name: t("appSettings"), exact: true }).click();
    await wait(600);
  });
});

it("02 接続後", async () => {
  const screen = await boot();
  await step("03-results", async () => { await connectAndOpen(screen); });
  await step("04-cmdk", async () => {
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.element(screen.getByRole("combobox", { name: t("cmdkPlaceholder") })).toBeVisible();
  });
  await userEvent.keyboard("{Escape}");
  await step("05-tools-menu", async () => {
    await screen.getByRole("button", { name: t("appTools"), exact: true }).click();
    await expect.element(screen.getByRole("menuitem", { name: t("appProcesses") })).toBeVisible();
    await wait(300);
  });
  await userEvent.keyboard("{Escape}");
  await step("06-dark", async () => {
    await screen.getByRole("button", { name: t("appThemeToggle"), exact: true }).click();
    await wait(600);
  });
});
```

ボタンやメニューは `t("キー")` で引く (ロケールを日本語にしているので、英語の
固定文字列でロケータを書くと見つからない)。同名の要素が複数ある場合は
`exact: true` を付ける。

## テンプレート: 撮影専用の設定

```ts
// vitest.ui-audit.config.ts (リポジトリ直下。一時ファイル)
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/__tests__/browser/ui-audit.browser.test.tsx"],
    setupFiles: ["./src/__tests__/browser/setup.browser.ts"],
    css: true,
    testTimeout: 60_000,
    expect: { poll: { timeout: 4_000 } },
    browser: {
      // クラウド実行環境では同梱 Chromium を直接指す (ローカルでは launchOptions 不要)
      provider: playwright({ launchOptions: { executablePath: "/opt/pw-browsers/chromium" } }),
      enabled: true,
      headless: true,
      viewport: { width: 1280, height: 800 },
      instances: [{ browser: "chromium" }],
    },
  },
});
```

`vitest.browser.config.ts` を `mergeConfig` で継承しようとすると、`instances` の
`chromium` プロジェクトが二重定義になって起動時に落ちる。上のように独立した設定を
書く。

## 見るときの観点

- 1280px 幅でツールバー・メニュー・タブ列が右端で切れていないか
- 同じ情報が 2 か所に出ていないか (ヘッダとステータスバーなど)
- 空状態に次の一手 (CTA) があるか
- ツールチップが隣の操作対象に重なっていないか
- ダークテーマで文字が消えていないか (`app.onSolid` / `app.text*` の取り違え)
- 中核機能 (プロセスモニタ・インスペクタ・アドバイザなど) の入口が画面上に見えるか

## 限界

- Tauri のネイティブウィンドウではない。タイトルバーの実描画・OS フォント・
  ウィンドウ幅の可変挙動は再現しない。
- `page.screenshot()` は Vitest のテスト iframe を撮る。ポータルで描かれる
  コンテキストメニューは、開いた直後に `wait(300)` を挟まないと写らないことがある。
- 右クリック (`click({ button: "right" })`) はツリー行でタイムアウトすることがある。
  撮れないときはコード読みで補う。
