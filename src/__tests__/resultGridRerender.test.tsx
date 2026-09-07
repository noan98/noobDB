import { Profiler, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { fireEvent, renderWithProviders, screen, within } from "./testUtils";
import { DataGrid, ResultGrid } from "../components/ResultGrid";
import type { CellValue, Column, QueryResult } from "../api/tauri";
import { setLocale, t } from "../i18n";

/**
 * Issue #1098 (Result Grid の再レンダリング削減) の回帰テスト。
 *
 * React DevTools Profiler での実測はヘッドレス環境では難しいため、代わりに
 * 「再レンダリング回数を数える」テストで代替する (Issue 側の指示どおり)。
 *
 * 注意: `<Profiler onRender>` は React.memo でバイパスされた commit でも
 * *呼ばれる* (呼ばれる回数では memo の効果を判定できない) が、その際
 * `actualDuration` は「そのサブツリーが実際にレンダー処理を行った時間」を
 * 反映し、バイパス時はほぼ 0 に近い値になる (mount 時や実際に props が
 * 変わったときの再レンダリングと比べて 1 桁以上小さい)。そのため本テストは
 * 呼び出し回数ではなく `actualDuration` の相対的な大小で memo のバイパスを
 * 判定する。
 *
 * - `DataGrid` (`ResultGrid.tsx`) を React.memo でラップしたことで、
 *   props が変わらないローカル state 更新 (検索バー入力・ストリーミング
 *   経過時間の tick など) では DataGrid 自体が実質的に再レンダリングされない
 *   (= バイパスされる) こと。
 * - 併せて、`columnStats` を `tableColumns` の依存配列から外して ref 経由に
 *   したことで (react-table の列モデルを毎バッチ作り直さないための変更)、
 *   条件付き書式 (データバー) の表示値が stale にならず、行が増えるたびに
 *   正しく最新の min/max に追従し続けることも検証する。
 */

function makeResult(columns: Column[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, rows_affected: rows.length, elapsed_ms: 1 };
}

describe("Result Grid の再レンダリング削減 (#1098)", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("DataGrid は React.memo でラップされ、props が変わらない再レンダリングは実質バイパスされる", () => {
    // 「バイパスされた再レンダリングはほぼ何もしない」ことを ms 単位の実測で
    // 見分けるには、実際の再レンダリング側のコストが計測ノイズに埋もれない
    // 程度に大きい必要がある。ストリーミング時に近い行数 (数百行) を用意し、
    // signal-to-noise 比を確保する (行数が少ないと "本来の再レンダリング" 自体
    // も一瞬で終わり、jsdom 環境でのタイマー分解能・GC のばらつきに紛れて
    // フレーキーになりやすい)。
    const columns: Column[] = [
      { name: "id", type_name: "INT" },
      { name: "name", type_name: "VARCHAR" },
      { name: "note", type_name: "VARCHAR" },
    ];
    const initialRows: CellValue[][] = Array.from({ length: 400 }, (_, i) => [
      i,
      `row-${i}`,
      `この行の説明テキストです ${i}`,
    ]);
    const durations: number[] = [];

    function Harness() {
      // `tick` は DataGrid に一切渡らないローカル state — ストリーミング経過時間の
      // tick や検索バー入力など、ResultGrid 自身のローカル state 更新を模している。
      const [tick, setTick] = useState(0);
      const [rowsForGrid, setRowsForGrid] = useState(initialRows);
      return (
        <div>
          <button onClick={() => setTick((v) => v + 1)}>tick:{tick}</button>
          <button onClick={() => setRowsForGrid((prev) => [...prev, [prev.length, "new", "追加行"]])}>
            add row
          </button>
          <Profiler
            id="grid"
            onRender={(_id, _phase, actualDuration) => { durations.push(actualDuration); }}
          >
            <DataGrid columns={columns} rows={rowsForGrid} />
          </Profiler>
        </div>
      );
    }

    renderWithProviders(<Harness />);
    const mountDuration = durations[0];
    expect(mountDuration).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("tick:0"));
    fireEvent.click(screen.getByText("tick:1"));
    fireEvent.click(screen.getByText("tick:2"));
    const tickOnlyDurations = durations.slice(1, 4);
    expect(tickOnlyDurations).toHaveLength(3);
    const medianTickDuration = [...tickOnlyDurations].sort((a, b) => a - b)[1];

    fireEvent.click(screen.getByText("add row"));
    const realUpdateDuration = durations[durations.length - 1];

    // props (columns/rows) が実際には変わらない tick だけの再レンダリングは
    // React.memo でバイパスされ、そのサブツリーはほぼ何もしない
    // (`actualDuration` がマウント時よりずっと小さい)。一方、rows が実際に
    // 増えたときは memo を素通りして本来のレンダリング処理が走るため、
    // tick だけのときよりも明確に (数倍以上) 長くかかる。
    expect(medianTickDuration).toBeLessThan(mountDuration * 0.5);
    expect(realUpdateDuration).toBeGreaterThan(medianTickDuration * 3);
  });

  it("ストリーミング的な行追加のあとも、データバーの条件付き書式が最新の min/max に追従する", async () => {
    const user = userEvent.setup();
    const columns: Column[] = [{ name: "qty", type_name: "INT" }];
    const initial = makeResult(columns, [[2], [5], [9]]);

    const { rerender, container } = renderWithProviders(<ResultGrid result={initial} />);

    // 列フィルタ/条件付き書式メニューを開き、データバー表示を有効にする。
    await user.click(screen.getByRole("button", { name: t("gridFilterAria", { column: "qty" }) }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: t("gridCondFormatLabel") }),
      "bar",
    );
    // メニューを閉じる (グリッド本体をクリック)。
    await user.click(document.body);

    const bars = () => Array.from(container.querySelectorAll<HTMLElement>(".cell-databar"));
    expect(bars().length).toBeGreaterThan(0);
    // 現在の範囲 (2..9) での最大値 (9) はバー幅 100%。
    const maxRowBarBefore = bars()[bars().length - 1];
    expect(maxRowBarBefore.style.transform).toBe("scaleX(1)");

    // ストリーミングでバッチが届いた想定で、既存行を先頭に保ったまま新しい行を
    // 追記した新しい配列参照を渡す (App.tsx の `[...prev, ...next]` と同じ形)。
    const grown = makeResult(columns, [...initial.rows, [20]]);
    rerender(<ResultGrid result={grown} />);

    // 依然として qty=9 の行は存在するが、範囲が (2..20) に広がったので
    // そのバー幅はもう 100% ではなくなっているはず — `columnStatsRef` 経由でも
    // 表示が古いままにならないことの確認 (#1098)。
    const nineRowBar = bars()[2];
    expect(nineRowBar.style.transform).not.toBe("scaleX(1)");
    // 新しく増えた qty=20 の行が新しい最大値としてバー幅 100%。
    const twentyRowBar = bars()[bars().length - 1];
    expect(twentyRowBar.style.transform).toBe("scaleX(1)");
  });
});
