import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { renderInBrowser } from "./render";
import { NotebookView } from "../../components/NotebookView";
import { makeProfile } from "../fixtures/componentFixtures";
import { setLocale, t } from "../../i18n";
import { createEmptyNotebook, newSqlCell } from "../../notebook";
import { replaceNotebook, updateNotebook } from "../../notebookStore";

// SQL ノートブックのヘッダ (#2469) を実ブラウザで検証する。jsdom ではレイアウトが計算されないため、
// 「サイドバー表示中の幅で、全実行中 + 未保存 + 古い結果ありでも 1 行に収まる」はここで確かめる。

// 1280px のウィンドウでサイドバー (既定 300px) を出したときの本文幅より少し狭い値。
const MAIN_WIDTH = 900;

const OUT = {
  columns: [{ name: "id", type_name: "int" }],
  rows: [[1]],
  totalRows: 1,
  rowsAffected: 0,
  hasColumns: true,
  elapsedMs: 3,
  serverMessages: undefined,
  readOnly: true,
  schemaMayChange: false,
  appliedAutoLimit: null,
};

function Host(props: { onRunSql: () => Promise<typeof OUT> }) {
  const profile = makeProfile();
  return (
    <div style={{ width: MAIN_WIDTH, height: 600, display: "flex", flexDirection: "column" }}>
      <NotebookView
        sessionId="s1"
        profile={profile}
        profiles={[profile]}
        openConnections={[{ sessionId: "s1", profile }]}
        schemaForDatabase={() => null}
        transactionActive={false}
        emergencyMode={false}
        onRunSql={props.onRunSql}
        onOpenInEditor={() => {}}
        onClose={() => {}}
      />
    </div>
  );
}

const centerY = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.top + r.height / 2;
};

describe("SQL ノートブックのヘッダ (#2469, 実ブラウザ)", () => {
  beforeEach(() => {
    // 日本語の方が文言が長く (プレースホルダも切れやすい)、実機の主な使われ方でもあるので日本語で測る。
    setLocale("ja");
    const d = createEmptyNotebook(null);
    d.cells = [newSqlCell("SELECT 1")];
    replaceNotebook(d, null);
  });

  it("全実行中 + 未保存 + 古い結果ありでも、サイドバー表示中の幅でヘッダが 1 行に収まる", async () => {
    let calls = 0;
    // 1 回目は即完了 (結果を残す)、2 回目は止めたままにして「実行中」を保つ。
    const onRunSql = vi.fn(() => (++calls === 1 ? Promise.resolve(OUT) : new Promise<typeof OUT>(() => {})));
    await renderInBrowser(<Host onRunSql={onRunSql} />);
    await page.getByRole("button", { name: new RegExp(t("notebookRunAll")) }).click();
    await expect.element(page.getByTestId("notebook-snapshot-meta")).toBeVisible();
    // SQL を書き換えて古い結果にし、もう一度流して実行中にする。
    updateNotebook((d) => ({
      ...d,
      cells: d.cells.map((c) => (c.kind === "sql" ? { ...c, sql: "SELECT 2" } : c)),
    }));
    await expect.element(page.getByTestId("notebook-stale-count")).toBeVisible();
    await page.getByRole("button", { name: new RegExp(t("notebookRunAll")) }).click();
    await expect.element(page.getByRole("button", { name: new RegExp(t("notebookStop")) })).toBeVisible();
    await expect.element(page.getByTestId("notebook-dirty")).toBeVisible();

    const header = document.querySelector("[data-testid=notebook-view] header") as HTMLElement;
    const stop = page.getByRole("button", { name: new RegExp(t("notebookStop")) }).element();
    const parts = [
      header.querySelector("input"),
      stop,
      page.getByRole("button", { name: t("notebookSave"), exact: true }).element(),
      page.getByTestId("notebook-more-actions").element(),
      page.getByRole("button", { name: t("notebookClose") }).element(),
      page.getByTestId("notebook-stale-count").element(),
      page.getByTestId("notebook-dirty").element(),
    ] as Element[];
    // 主要要素の縦位置 (中心) が揃い、ヘッダの高さも 1 行分に収まる。
    const base = centerY(parts[0]);
    for (const el of parts) expect(Math.abs(centerY(el) - base)).toBeLessThan(2);
    const tops = parts.map((el) => el.getBoundingClientRect().top);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(header.getBoundingClientRect().height / 2);
    expect(header.getBoundingClientRect().height).toBeLessThan(parts[0].getBoundingClientRect().height * 2);
    // タイトル入力のプレースホルダが切れない (入力が余り幅を取れている)。
    const title = parts[0] as HTMLInputElement;
    const probe = document.createElement("span");
    probe.textContent = title.placeholder;
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(title).font}`;
    document.body.appendChild(probe);
    const need = probe.getBoundingClientRect().width;
    probe.remove();
    expect(title.clientWidth).toBeGreaterThanOrEqual(need);
    expect(header.scrollWidth).toBeLessThanOrEqual(header.clientWidth + 1);
  });
});
