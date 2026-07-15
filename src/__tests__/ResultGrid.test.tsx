import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from "./testUtils";
import { ResultGrid, GRID_CSS, isColumnFilterActive, type ResultGridHandle, readStoredColumnSizing, writeStoredColumnSizing, colStateKeyFrom, readStoredColumnState, writeStoredColumnState } from "../components/ResultGrid";
import { rowEditKey } from "../components/cellEdit";
import type { Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { setLocale, t } from "../i18n";
import { setRichCellRendering } from "../settings";
import { formatJsonCompact } from "../components/cellFormat";

// ResultGrid の主要インタラクション (描画・全文フィルタ・列ソート・ページ読み込み
// トリガー・インラインセル編集) の退行を検出するテスト。リファクタリングや
// 機能追加で表示・編集フローが壊れたことを CI で自動検出できるようにする。
//
// 文言はロケールで変わるため i18n の `t()` から期待値を引く。バックエンド (IPC) は
// 呼ばないため `api/tauri` のモックは不要 (ResultGrid は受け取った `result` を
// 描画するだけで、編集の確定はコールバック経由で親に委ねる)。

function makeResult(columns: Column[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, rows_affected: 0, elapsed_ms: 3 };
}

const FRUIT_COLUMNS: Column[] = [
  { name: "name", type_name: "VARCHAR" },
  { name: "qty", type_name: "INT" },
];

const FRUIT_RESULT = makeResult(FRUIT_COLUMNS, [
  ["banana", 2],
  ["apple", 5],
  ["cherry", 9],
]);

/** tbody の各行から、データ列のテキストを行順に取り出す (行番号セルは除く)。 */
function dataRowTexts(container: HTMLElement): string[][] {
  const bodyRows = container.querySelectorAll("tbody tr");
  return Array.from(bodyRows).map((tr) =>
    Array.from(tr.querySelectorAll("td"))
      .filter((td) => !td.classList.contains("row-index") && !td.classList.contains("col-filler"))
      .map((td) => td.textContent ?? ""),
  );
}

describe("ResultGrid", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("列ヘッダと全行のセルを描画する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    // ヘッダ (ソート可能なのでボタンとして描画される)
    expect(screen.getByRole("button", { name: /^name/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^qty/ })).toBeInTheDocument();

    expect(dataRowTexts(container)).toEqual([
      ["banana", "2"],
      ["apple", "5"],
      ["cherry", "9"],
    ]);
  });

  it("空の結果セットでは資格に応じたプレースホルダを表示する", () => {
    renderWithProviders(<ResultGrid result={null} />);
    expect(screen.getByText(t("resultEmpty"))).toBeInTheDocument();
  });

  it("全文フィルタで一致行だけに絞り込み、件数サマリを表示する", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    const search = screen.getByLabelText(t("gridSearchAria"));
    await user.type(search, "an");

    // "banana" のみ "an" を含む。
    expect(dataRowTexts(container)).toEqual([["banana", "2"]]);
    expect(
      screen.getByText(t("gridFilteredCount", { shown: 1, total: 3 })),
    ).toBeInTheDocument();
  });

  it("一致行が無いフィルタでは専用メッセージを表示する", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    await user.type(screen.getByLabelText(t("gridSearchAria")), "zzz");

    expect(screen.getByText(t("gridNoMatches"))).toBeInTheDocument();
  });

  it("列ヘッダのクリックで昇順 → 降順にソートする", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    // 1 回目: name 昇順
    await user.click(screen.getByRole("button", { name: /^name/ }));
    expect(dataRowTexts(container).map((r) => r[0])).toEqual([
      "apple",
      "banana",
      "cherry",
    ]);

    // 2 回目: name 降順
    await user.click(screen.getByRole("button", { name: /^name/ }));
    expect(dataRowTexts(container).map((r) => r[0])).toEqual([
      "cherry",
      "banana",
      "apple",
    ]);
  });

  it("末尾付近までスクロール可能なとき onLoadMore を発火する", async () => {
    const onLoadMore = vi.fn();
    renderWithProviders(
      <ResultGrid result={FRUIT_RESULT} canLoadMore onLoadMore={onLoadMore} />,
    );
    // jsdom ではビューポート寸法が 0 のため、初回マウント時の判定で
    // 「末尾付近」と見なされ、すぐに読み込みがトリガーされる。
    await waitFor(() => expect(onLoadMore).toHaveBeenCalled());
  });

  it("これ以上ページが無いときは onLoadMore を発火しない", () => {
    const onLoadMore = vi.fn();
    renderWithProviders(
      <ResultGrid result={FRUIT_RESULT} canLoadMore={false} onLoadMore={onLoadMore} />,
    );
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("自動 LIMIT が効いているとバッジを出し、全件取得で onFetchAllRows を呼ぶ", async () => {
    const user = userEvent.setup();
    const onFetchAllRows = vi.fn();
    // rows.length (3) >= autoLimitApplied (3) のときだけバッジが出る。
    renderWithProviders(
      <ResultGrid
        result={FRUIT_RESULT}
        autoLimitApplied={3}
        onFetchAllRows={onFetchAllRows}
      />,
    );

    expect(screen.getByText(t("autoLimitApplied", { limit: 3 }))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: t("autoLimitFetchAll") }));
    expect(onFetchAllRows).toHaveBeenCalledTimes(1);
  });

  describe("インラインセル編集", () => {
    const columns: Column[] = [
      { name: "id", type_name: "INT" },
      { name: "name", type_name: "VARCHAR" },
    ];
    const tableColumns: TableColumnInfo[] = [
      {
        name: "id",
        data_type: "int",
        nullable: false,
        key: "PRI",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
      {
        name: "name",
        data_type: "varchar",
        nullable: true,
        key: "",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
    ];
    const result = makeResult(columns, [[1, "alice"]]);

    it("編集可能セルをダブルクリックして値を変更すると onSetCellEdit が呼ばれる", async () => {
      const user = userEvent.setup();
      const onSetCellEdit = vi.fn();
      const { container } = renderWithProviders(
        <ResultGrid
          result={result}
          editable
          tableColumns={tableColumns}
          onSetCellEdit={onSetCellEdit}
        />,
      );

      // 編集可能列 (name) のセル。PK 列 (id) は編集不可。
      const nameCell = container.querySelector("td.is-editable-cell") as HTMLElement;
      expect(nameCell).toBeTruthy();
      await user.dblClick(nameCell);

      const input = within(nameCell).getByRole("textbox");
      await user.clear(input);
      await user.type(input, "bob");
      // Enter で確定 → 親へ通知。
      await user.keyboard("{Enter}");

      // 行は配列インデックスではなく主キー由来の安定キーで識別される。
      expect(onSetCellEdit).toHaveBeenCalledWith(rowEditKey([1, "alice"], [0], 0), 1, "bob");
    });

    it("PK 列 (id) は編集不可セルにならない", () => {
      const { container } = renderWithProviders(
        <ResultGrid
          result={result}
          editable
          tableColumns={tableColumns}
          onSetCellEdit={() => {}}
        />,
      );
      // 編集可能セルは name の 1 つだけ (id は PK のため除外)。
      expect(container.querySelectorAll("td.is-editable-cell")).toHaveLength(1);
    });
  });
});

describe("カラム別フィルタ (#390)", () => {
  beforeEach(() => setLocale("en"));

  const NULLABLE_COLUMNS: Column[] = [
    { name: "name", type_name: "VARCHAR" },
    { name: "qty", type_name: "INT" },
  ];
  const NULLABLE_RESULT = makeResult(NULLABLE_COLUMNS, [
    ["banana", 2],
    ["apple", 5],
    ["cherry", 9],
    [null, 7],
  ]);

  /** Open the per-column filter popup by clicking the header's filter icon. */
  async function openFilter(user: ReturnType<typeof userEvent.setup>, column: string) {
    await user.click(
      screen.getByRole("button", { name: t("gridFilterAria", { column }) }),
    );
    return screen.getByRole("dialog");
  }

  it("テキスト列を contains で絞り込み、列ヘッダをハイライトする", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    const dialog = await openFilter(user, "name");
    // 既定演算子 (contains) のまま値を入力。
    await user.type(within(dialog).getByRole("textbox"), "an");

    expect(dataRowTexts(container)).toEqual([["banana", "2"]]);
    // フィルタが効いた列はヘッダがアクセント色で区別される。
    expect(container.querySelector("th.is-filtered-col")).not.toBeNull();
    expect(container.querySelector(".th-filter-button.is-active")).not.toBeNull();
  });

  it("テキスト列の equals は完全一致のみ通す", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    const dialog = await openFilter(user, "name");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: t("gridFilterOperatorLabel") }),
      "equals",
    );
    await user.type(within(dialog).getByRole("textbox"), "apple");

    expect(dataRowTexts(container)).toEqual([["apple", "5"]]);
  });

  it("数値列を > で絞り込む", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    const dialog = await openFilter(user, "qty");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: t("gridFilterOperatorLabel") }),
      "gt",
    );
    await user.type(within(dialog).getByRole("textbox"), "4");

    expect(dataRowTexts(container).map((r) => r[0])).toEqual(["apple", "cherry"]);
  });

  it("数値列を範囲 (between) で絞り込む", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    const dialog = await openFilter(user, "qty");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: t("gridFilterOperatorLabel") }),
      "between",
    );
    await user.type(
      within(dialog).getByLabelText(t("gridFilterMinPlaceholder")),
      "3",
    );
    await user.type(
      within(dialog).getByLabelText(t("gridFilterMaxPlaceholder")),
      "6",
    );

    expect(dataRowTexts(container)).toEqual([["apple", "5"]]);
  });

  it("NULL のみ / NULL を除外でフィルタできる", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={NULLABLE_RESULT} />);

    const dialog = await openFilter(user, "name");
    const nullSelect = within(dialog).getByRole("combobox", {
      name: t("gridFilterNullLabel"),
    });

    // NULL のみ → name が NULL の 1 行だけ。
    await user.selectOptions(nullSelect, "only");
    expect(dataRowTexts(container).map((r) => r[1])).toEqual(["7"]);

    // NULL を除外 → NULL 行が落ちる。
    await user.selectOptions(nullSelect, "exclude");
    expect(dataRowTexts(container).map((r) => r[0])).toEqual([
      "banana",
      "apple",
      "cherry",
    ]);
  });

  it("カラムフィルタはグローバルフィルタと AND 結合で動作する", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    // 全文検索で "a" を含む行 (banana / apple) に絞る。
    await user.type(screen.getByLabelText(t("gridSearchAria")), "a");
    // さらに qty >= 5 のカラムフィルタを足すと apple だけが残る。
    const dialog = await openFilter(user, "qty");
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: t("gridFilterOperatorLabel") }),
      "gt",
    );
    await user.type(within(dialog).getByRole("textbox"), "4");

    expect(dataRowTexts(container)).toEqual([["apple", "5"]]);
  });

  it("ポップアップのクリアでフィルタを解除する", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    const dialog = await openFilter(user, "name");
    await user.type(within(dialog).getByRole("textbox"), "an");
    expect(dataRowTexts(container)).toEqual([["banana", "2"]]);

    await user.click(
      within(dialog).getByRole("button", { name: t("gridFilterClearColumn") }),
    );
    // 全行に戻り、ハイライトも消える。
    expect(dataRowTexts(container)).toHaveLength(3);
    expect(container.querySelector("th.is-filtered-col")).toBeNull();
  });

  it("2^53 を超える BIGINT を精度を落とさず等値比較する", async () => {
    const user = userEvent.setup();
    // 連続する大整数は Number に丸めると同値になってしまう。BigInt 比較なら
    // 正しく 1 行だけに絞り込めることを確認する。
    const cols: Column[] = [{ name: "id", type_name: "BIGINT" }];
    const result = makeResult(cols, [
      ["9007199254740993"],
      ["9007199254740992"],
    ]);
    const { container } = renderWithProviders(<ResultGrid result={result} />);

    const dialog = await openFilter(user, "id");
    await user.type(within(dialog).getByRole("textbox"), "9007199254740993");

    // Number ベースの等値だと両行が同じ値に丸められて 2 行残る。BigInt 比較なら
    // ちょうど 1 行に絞り込めるので、行数で精度を検証する (表示は number 列として
    // 整形されるため、生文字列ではなく件数で確認する)。
    expect(dataRowTexts(container)).toHaveLength(1);
  });

  it("isColumnFilterActive は値も NULL ゲートも無い条件を非アクティブと判定する", () => {
    expect(isColumnFilterActive(undefined)).toBe(false);
    expect(
      isColumnFilterActive({ op: "contains", value: "", value2: "", nullMode: "any" }),
    ).toBe(false);
    expect(
      isColumnFilterActive({ op: "contains", value: "x", value2: "", nullMode: "any" }),
    ).toBe(true);
    expect(
      isColumnFilterActive({ op: "eq", value: "", value2: "", nullMode: "exclude" }),
    ).toBe(true);
    expect(
      isColumnFilterActive({ op: "between", value: "", value2: "5", nullMode: "any" }),
    ).toBe(true);
  });
});

describe("データタイプ別の視覚表現 (#385)", () => {
  beforeEach(() => setLocale("en"));

  it("NULL セルは cell-null バッジで描画され、空文字列セルとは区別される", () => {
    const cols: Column[] = [
      { name: "note", type_name: "VARCHAR" },
      { name: "qty", type_name: "INT" },
    ];
    const { container } = renderWithProviders(
      <ResultGrid result={makeResult(cols, [[null, 1], ["", 2]])} />,
    );
    const nullBadges = container.querySelectorAll(".cell-null");
    // NULL の行だけにバッジが付き、空文字列の行には付かない。
    expect(nullBadges).toHaveLength(1);
    expect(nullBadges[0].textContent).toBe(t("resultNull"));
  });

  it("数値列は align-right が付き、右揃えになる", () => {
    const cols: Column[] = [{ name: "qty", type_name: "INT" }];
    const { container } = renderWithProviders(
      <ResultGrid result={makeResult(cols, [[42]])} />,
    );
    const cell = container.querySelector("tbody td.col-number");
    expect(cell?.classList.contains("align-right")).toBe(true);
  });

  it("BLOB セルは BLOB ラベルとバイト長を表示する", () => {
    const cols: Column[] = [{ name: "data", type_name: "BLOB" }];
    // 4 文字の 16 進 → 2 バイト。
    const { container } = renderWithProviders(
      <ResultGrid result={makeResult(cols, [["dead"]])} />,
    );
    const tag = container.querySelector(".cell-binary-tag");
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toBe(t("gridBlobBytes", { size: "2 B" }));
  });

  it("GRID_CSS の NULL バッジは枠線付きピルとして定義される", () => {
    const css = GRID_CSS as Record<string, { border?: string; borderRadius?: string }>;
    expect(css["& .cell-null"]?.border).toContain("var(--text-null)");
    expect(css["& .cell-binary-tag"]?.border).toContain("var(--cell-binary)");
  });
});

describe("セル値のリッチ表示 (#451)", () => {
  beforeEach(() => {
    setLocale("en");
    setRichCellRendering(true);
  });

  it("JSON セルはコンパクトに整形され、title に原文を残す", () => {
    const cols: Column[] = [{ name: "meta", type_name: "JSON" }];
    const raw = '{ "a": 1,  "b": [2, 3] }';
    const { container } = renderWithProviders(
      <ResultGrid result={makeResult(cols, [[raw]])} />,
    );
    const cell = container.querySelector("tbody td .cell-json");
    expect(cell?.textContent).toBe(formatJsonCompact(raw));
    // 原文は title (コピー/編集で使う実値) に保持される。
    expect(cell?.getAttribute("title")).toBe(raw);
  });

  it("真偽値はピル型バッジ (cell-bool-badge) で描画される", () => {
    const cols: Column[] = [{ name: "active", type_name: "BOOLEAN" }];
    const { container } = renderWithProviders(
      <ResultGrid result={makeResult(cols, [[true], [false]])} />,
    );
    const badges = container.querySelectorAll(".cell-bool-badge");
    expect(badges).toHaveLength(2);
    expect(badges[0].classList.contains("is-true")).toBe(true);
    expect(badges[0].textContent).toBe("true");
    expect(badges[1].classList.contains("is-false")).toBe(true);
  });

  it("ENUM 列は色相を持つ色分けバッジで描画される", () => {
    const cols: Column[] = [{ name: "status", type_name: "ENUM" }];
    const { container } = renderWithProviders(
      <ResultGrid result={makeResult(cols, [["active"]])} />,
    );
    const badge = container.querySelector(".cell-enum-badge") as HTMLElement | null;
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("active");
    expect(badge?.style.getPropertyValue("--enum-hue")).not.toBe("");
  });

  it("日付列はロケール整形され、title に原文 (実値) を残す", () => {
    const cols: Column[] = [{ name: "created", type_name: "DATE" }];
    const { container } = renderWithProviders(
      <ResultGrid result={makeResult(cols, [["2026-06-01"]])} />,
    );
    const cell = container.querySelector("tbody td .cell-date");
    expect(cell?.textContent).toBe("Jun 1, 2026");
    expect(cell?.getAttribute("title")).toBe("2026-06-01");
  });

  it("リッチ表示を OFF にすると素の値で描画される (整形なし)", () => {
    setRichCellRendering(false);
    const cols: Column[] = [{ name: "meta", type_name: "JSON" }];
    const raw = '{ "a": 1 }';
    const { container } = renderWithProviders(
      <ResultGrid result={makeResult(cols, [[raw]])} />,
    );
    const cell = container.querySelector("tbody td .cell-json");
    expect(cell?.textContent).toBe(raw);
    expect(cell?.getAttribute("title")).toBeNull();
  });
});

describe("editable-cell visual affordance (#349, #540)", () => {
  it("GRID_CSS distinguishes editable cells with cursor + hover/active ring", () => {
    // 編集可能セルはテキストカーソル、ホバーで細いアクセントリング、編集中 (focus内)
    // で inset フォーカスリング (--focus-ring-inset) を出す。
    // 読み取り専用/非編集セルは既定カーソル。
    const css = GRID_CSS as Record<string, { cursor?: string; outline?: string; boxShadow?: string }>;
    expect(css["& td.is-editable-cell"]?.cursor).toBe("text");
    expect(
      css["& tbody td:not(.row-index):not(.col-filler):not(.grid-empty-cell)"]?.cursor,
    ).toBe("default");
    expect(css["& tbody tr td.is-editable-cell:hover"]?.outline).toContain("var(--accent)");
    // focus-within は outline ではなく inset box-shadow で描画する。
    expect(css["& td.is-editable-cell:focus-within"]?.boxShadow).toContain("var(--focus-ring-inset)");
  });
});

// 列幅永続化ユーティリティのユニットテスト
describe("column sizing persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("存在しないキーは空オブジェクトを返す", () => {
    expect(readStoredColumnSizing("noobdb.colsizing.v1::db::t1::[\"a\"]")).toEqual({});
  });

  it("undefined キーは常に空オブジェクトを返す", () => {
    expect(readStoredColumnSizing(undefined)).toEqual({});
  });

  it("書き込んだ列幅を同じキーで読み返せる", () => {
    const key = 'noobdb.colsizing.v1::db::users::["id","name"]';
    writeStoredColumnSizing(key, { "0": 80, "1": 200 });
    expect(readStoredColumnSizing(key)).toEqual({ "0": 80, "1": 200 });
  });

  it("書き込みを重ねると最新の値で上書きされる", () => {
    const key = 'noobdb.colsizing.v1::db::users::["id"]';
    writeStoredColumnSizing(key, { "0": 80 });
    writeStoredColumnSizing(key, { "0": 160 });
    expect(readStoredColumnSizing(key)).toEqual({ "0": 160 });
  });

  it("異なるキーの値は独立して保持される", () => {
    const k1 = 'noobdb.colsizing.v1::db::t1::["a"]';
    const k2 = 'noobdb.colsizing.v1::db::t2::["b"]';
    writeStoredColumnSizing(k1, { "0": 100 });
    writeStoredColumnSizing(k2, { "0": 200 });
    expect(readStoredColumnSizing(k1)).toEqual({ "0": 100 });
    expect(readStoredColumnSizing(k2)).toEqual({ "0": 200 });
  });

  it("50 エントリ上限を超えると最も古いエントリが削除される", () => {
    const keys: string[] = [];
    for (let i = 0; i < 50; i++) {
      const k = `noobdb.colsizing.v1::db::t${i}::["col"]`;
      keys.push(k);
      writeStoredColumnSizing(k, { "0": i });
    }
    // この時点で 50 エントリ。最初に書いた t0 が最も古い (LRU 末尾)。
    expect(readStoredColumnSizing(keys[0])).toEqual({ "0": 0 });

    // 51 件目を書くと最古の t0 が削除される。
    const k51 = 'noobdb.colsizing.v1::db::t50::["col"]';
    writeStoredColumnSizing(k51, { "0": 50 });
    expect(readStoredColumnSizing(keys[0])).toEqual({});
    expect(readStoredColumnSizing(k51)).toEqual({ "0": 50 });
  });

  it("既存キーを再書き込みすると LRU 先頭に移動し、別エントリが削除されない", () => {
    const keys: string[] = [];
    for (let i = 0; i < 50; i++) {
      const k = `noobdb.colsizing.v1::db::u${i}::["col"]`;
      keys.push(k);
      writeStoredColumnSizing(k, { "0": i });
    }
    // u0 を更新 → LRU 先頭へ移動。
    writeStoredColumnSizing(keys[0], { "0": 999 });
    // 51 件目を書くと末尾 (u1) が削除される。u0 は先頭のため残る。
    const kNew = 'noobdb.colsizing.v1::db::uNew::["col"]';
    writeStoredColumnSizing(kNew, { "0": 100 });
    expect(readStoredColumnSizing(keys[0])).toEqual({ "0": 999 });
    expect(readStoredColumnSizing(keys[1])).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 列レイアウト永続化 (順序 / 表示 / ピン)
// ─────────────────────────────────────────────────────────────────────────────
describe("列レイアウト永続化 (#447 / #463)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("列幅キーから列状態キーを導出する (同じ result shape)", () => {
    const sizing = 'noobdb.colsizing.v1::db::users::["id","name"]';
    expect(colStateKeyFrom(sizing)).toBe('noobdb.colstate.v1::db::users::["id","name"]');
    expect(colStateKeyFrom(undefined)).toBeUndefined();
  });

  it("存在しない / undefined キーは空オブジェクトを返す", () => {
    expect(readStoredColumnState("noobdb.colstate.v1::db::t::[]")).toEqual({});
    expect(readStoredColumnState(undefined)).toEqual({});
  });

  it("order / visibility / pinning を書き込んで読み返せる", () => {
    const key = 'noobdb.colstate.v1::db::users::["id","name","email"]';
    const state = {
      order: ["2", "0", "1"],
      visibility: { "1": false },
      pinning: { left: ["0"], right: [] },
    };
    writeStoredColumnState(key, state);
    expect(readStoredColumnState(key)).toEqual(state);
  });

  it("空のレイアウトを書き込むとエントリ自体を削除する (既定に戻す)", () => {
    const key = 'noobdb.colstate.v1::db::users::["id"]';
    writeStoredColumnState(key, { order: ["0"], visibility: { "0": false } });
    expect(readStoredColumnState(key)).not.toEqual({});
    writeStoredColumnState(key, { order: [], visibility: {}, pinning: { left: [], right: [] } });
    expect(localStorage.getItem(key)).toBeNull();
    expect(readStoredColumnState(key)).toEqual({});
  });

  it("undefined キーへの書き込みは無視される", () => {
    expect(() => writeStoredColumnState(undefined, { order: ["0"] })).not.toThrow();
  });

  it("列メニューから列を左にピン留めすると sticky 固定クラスが付く (#463)", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    // qty 列のフィルタ/列メニューを開く。
    await user.click(
      screen.getByRole("button", { name: t("gridFilterAria", { column: "qty" }) }),
    );
    // ピン留めセレクトで「左に固定」を選ぶ。
    const pinSelect = screen.getByText(t("gridPinLeft")).closest("select") as HTMLSelectElement;
    await user.selectOptions(pinSelect, "left");

    // ヘッダ・ボディの該当列が左ピン留めクラスを得る。
    const pinnedTh = container.querySelector("th.is-pinned-left");
    expect(pinnedTh).not.toBeNull();
    expect(pinnedTh?.textContent).toContain("qty");
    expect(container.querySelector("td.is-pinned-left")).not.toBeNull();
    // sticky 配置になっている。
    expect((pinnedTh as HTMLElement).style.position).toBe("sticky");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 集計フッター行 (#645)
// ─────────────────────────────────────────────────────────────────────────────
describe("集計フッター行 (#645)", () => {
  beforeEach(() => {
    setLocale("en");
    localStorage.clear();
  });

  /** フッター行の各データセルのテキストを列順に取り出す。 */
  function footerTexts(container: HTMLElement): string[] {
    const cells = container.querySelectorAll("tfoot td");
    return Array.from(cells)
      .filter((td) => !td.classList.contains("row-index") && !td.classList.contains("col-filler"))
      .map((td) => td.textContent ?? "");
  }

  it("列メニューから集計フッターを表示し、数値列は合計・文字列列は件数を出す", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);

    // 初期状態ではフッターは無い。
    expect(container.querySelector("tfoot")).toBeNull();

    // qty 列の列メニューを開き「集計フッターを表示」を押す。
    await user.click(
      screen.getByRole("button", { name: t("gridFilterAria", { column: "qty" }) }),
    );
    await user.click(screen.getByText(t("gridFooterShow")));

    // フッターが現れ、qty 列は合計 (2+5+9=16)、name 列は非NULL件数 (3)。
    const foot = container.querySelector("tfoot");
    expect(foot).not.toBeNull();
    const texts = footerTexts(container);
    // name 列: "Count" ラベル + 3、qty 列: "Sum" ラベル + 16。
    expect(texts[0]).toContain("3");
    expect(texts[0]).toContain(t("gridCountLabel"));
    expect(texts[1]).toContain("16");
    expect(texts[1]).toContain(t("gridSumLabel"));
  });

  it("列統計メニューで集計関数を切替でき、テーブル単位で永続化される", async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderWithProviders(
      <ResultGrid result={FRUIT_RESULT} database="db" table="fruit" />,
    );

    // qty 列の列メニュー → 「列の統計」を開く。
    await user.click(
      screen.getByRole("button", { name: t("gridFilterAria", { column: "qty" }) }),
    );
    await user.click(screen.getByText(t("gridColumnStats")));

    // フッター関数セレクタで avg (平均) に切替。これでフッターが自動で表示される。
    const sel = screen.getByLabelText(
      t("gridFooterSelectAria", { column: "qty" }),
    ) as HTMLSelectElement;
    await user.selectOptions(sel, "avg");

    // qty 列フッターが平均 ((2+5+9)/3 = 5.333…) を表示する。
    await waitFor(() => {
      const texts = footerTexts(container);
      expect(texts[1]).toContain(t("gridAvgLabel"));
      expect(texts[1]).toContain("5.33");
    });

    // 再マウントしても状態 (表示 + avg 選択) が localStorage から復元される。
    unmount();
    const { container: c2 } = renderWithProviders(
      <ResultGrid result={FRUIT_RESULT} database="db" table="fruit" />,
    );
    expect(c2.querySelector("tfoot")).not.toBeNull();
    expect(footerTexts(c2)[1]).toContain("5.33");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 複数列ソート
// ─────────────────────────────────────────────────────────────────────────────
describe("複数列ソート (#479)", () => {
  beforeEach(() => setLocale("en"));

  const SORT_COLUMNS: Column[] = [
    { name: "status", type_name: "VARCHAR" },
    { name: "qty", type_name: "INT" },
  ];
  const SORT_RESULT = makeResult(SORT_COLUMNS, [
    ["b", 3],
    ["a", 2],
    ["a", 1],
    ["b", 1],
  ]);

  it("Shift+クリックで第2ソートキーを追加し、優先順位と方向を表示する", async () => {
    const { container } = renderWithProviders(<ResultGrid result={SORT_RESULT} />);

    // status を昇順 (単一ソート)。
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^status/ }));
    // qty を Shift 押下中にクリックして第2キーに追加。
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /^qty/ }));
    await user.keyboard("{/Shift}");

    // status 昇順 → 同値内は qty で第2ソート (数値列は降順が既定)。
    expect(dataRowTexts(container)).toEqual([
      ["a", "2"],
      ["a", "1"],
      ["b", "3"],
      ["b", "1"],
    ]);

    // 優先順位バッジ (1, 2) が両ヘッダに出る。
    expect(screen.getByLabelText(t("gridSortPriority", { n: 1 }))).toBeInTheDocument();
    expect(screen.getByLabelText(t("gridSortPriority", { n: 2 }))).toBeInTheDocument();

    // aria-sort が両列に付与される (status=ascending, qty=descending)。
    const ths = Array.from(container.querySelectorAll("thead th"));
    const sorted = ths.filter((th) => {
      const v = th.getAttribute("aria-sort");
      return v === "ascending" || v === "descending";
    });
    expect(sorted.length).toBe(2);
  });

  it("複数列ソート時はサマリにクリア導線が出て、全解除できる", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={SORT_RESULT} />);

    await user.click(screen.getByRole("button", { name: /^status/ }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /^qty/ }));
    await user.keyboard("{/Shift}");

    const clearBtn = screen.getByRole("button", { name: t("gridClearSort") });
    await user.click(clearBtn);

    // 解除後は元の挿入順に戻る。
    expect(dataRowTexts(container)).toEqual([
      ["b", "3"],
      ["a", "2"],
      ["a", "1"],
      ["b", "1"],
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// キーボードセルナビゲーション
// ─────────────────────────────────────────────────────────────────────────────
describe("キーボードセルナビゲーション (#406)", () => {
  beforeEach(() => {
    // 直前の describe で永続化した列レイアウト (ピン/順序) が同一 result shape の
    // ストレージキー経由で漏れ込み、列順が変わってナビが狂うのを防ぐ。
    localStorage.clear();
    setLocale("en");
  });

  /** tbody のデータ <td> だけ (row-index・col-filler を除く) を行×列の 2D 配列で返す。 */
  function dataCells(container: HTMLElement): HTMLElement[][] {
    return Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td[role='gridcell']")) as HTMLElement[],
    );
  }

  it("セルにフォーカスすると is-active-cell クラスが付く", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    const cell = cells[0][0];
    fireEvent.focus(cell);
    expect(cell.classList.contains("is-active-cell")).toBe(true);
  });

  it("ArrowDown でひとつ下の行に移動する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "ArrowDown" });
    expect(cells[1][0].classList.contains("is-active-cell")).toBe(true);
    expect(cells[0][0].classList.contains("is-active-cell")).toBe(false);
  });

  it("ArrowUp でひとつ上の行に移動する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[1][0]);
    fireEvent.keyDown(cells[1][0], { key: "ArrowUp" });
    expect(cells[0][0].classList.contains("is-active-cell")).toBe(true);
  });

  it("ArrowRight でひとつ右の列に移動する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "ArrowRight" });
    expect(cells[0][1].classList.contains("is-active-cell")).toBe(true);
  });

  it("ArrowLeft でひとつ左の列に移動する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][1]);
    fireEvent.keyDown(cells[0][1], { key: "ArrowLeft" });
    expect(cells[0][0].classList.contains("is-active-cell")).toBe(true);
  });

  it("Home で同行の先頭列に移動する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][1]);
    fireEvent.keyDown(cells[0][1], { key: "Home" });
    expect(cells[0][0].classList.contains("is-active-cell")).toBe(true);
  });

  it("End で同行の末尾列に移動する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "End" });
    expect(cells[0][1].classList.contains("is-active-cell")).toBe(true);
  });

  it("Tab で次の列に移動し、行末では次行の先頭列に移動する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    // 行末列 (col 1) → Tab → 次行先頭 (row 1, col 0)
    fireEvent.focus(cells[0][1]);
    fireEvent.keyDown(cells[0][1], { key: "Tab" });
    expect(cells[1][0].classList.contains("is-active-cell")).toBe(true);
  });

  it("Shift+Tab で前の列に移動し、行頭では前行の末尾列に移動する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    // 行頭列 (row 1, col 0) → Shift+Tab → 前行末尾 (row 0, col 1)
    fireEvent.focus(cells[1][0]);
    fireEvent.keyDown(cells[1][0], { key: "Tab", shiftKey: true });
    expect(cells[0][1].classList.contains("is-active-cell")).toBe(true);
  });

  it("Escape でアクティブセルが解除される", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    expect(cells[0][0].classList.contains("is-active-cell")).toBe(true);
    fireEvent.keyDown(cells[0][0], { key: "Escape" });
    expect(cells[0][0].classList.contains("is-active-cell")).toBe(false);
  });

  it("Ctrl+C で現在のセル値がクリップボードにコピーされる", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("banana"));
  });

  it("Shift+矢印でセルの矩形範囲を選択する (#486)", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(cells[0][1], { key: "ArrowDown", shiftKey: true });
    // 2x2 の範囲が選択状態になる。
    const selected = container.querySelectorAll("td.is-selected-cell");
    expect(selected.length).toBe(4);
  });

  it("Ctrl+C で選択範囲を TSV としてコピーする (#486)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(cells[0][1], { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(cells[1][1], { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("banana\t2\napple\t5"));
  });

  it("Ctrl+Shift+C で列名ヘッダ付きの範囲コピーをする (#486)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(cells[0][1], { key: "c", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("name\tqty\nbanana\t2"));
  });

  it("Escape で選択範囲を解除する (#486)", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "ArrowRight", shiftKey: true });
    expect(container.querySelectorAll("td.is-selected-cell").length).toBe(2);
    fireEvent.keyDown(cells[0][1], { key: "Escape" });
    expect(container.querySelectorAll("td.is-selected-cell").length).toBe(0);
  });

  it("テーブルに role=grid、行に role=row、データセルに role=gridcell が付く", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    expect(container.querySelector("table[role='grid']")).toBeTruthy();
    const bodyRows = container.querySelectorAll("tbody tr[role='row']");
    expect(bodyRows.length).toBeGreaterThan(0);
    expect(container.querySelector("td[role='gridcell']")).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 行インスペクタ
// ─────────────────────────────────────────────────────────────────────────────
describe("行インスペクタ (#462)", () => {
  beforeEach(() => setLocale("en"));

  function dataCells(container: HTMLElement): HTMLElement[][] {
    return Array.from(container.querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td[role='gridcell']")) as HTMLElement[],
    );
  }

  it("Alt+Enter で選択行の全カラムを縦表示し、行移動に追従する", () => {
    const { container } = renderWithProviders(<ResultGrid result={FRUIT_RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "Enter", altKey: true });

    const dialog = screen.getByRole("dialog", { name: t("gridRowInspectorTitle", { row: 1 }) });
    // 全カラム名と 1 行目の値が縦に並ぶ。
    expect(within(dialog).getByText("name")).toBeInTheDocument();
    expect(within(dialog).getByText("qty")).toBeInTheDocument();
    expect(within(dialog).getByText("banana")).toBeInTheDocument();
    expect(within(dialog).getByText("2")).toBeInTheDocument();

    // 次の行へ追従。
    fireEvent.click(within(dialog).getByRole("button", { name: t("gridInspectorNext") }));
    const dialog2 = screen.getByRole("dialog", { name: t("gridRowInspectorTitle", { row: 2 }) });
    expect(within(dialog2).getByText("apple")).toBeInTheDocument();
  });

  it("NULL は専用表記で示し、Esc で閉じる", () => {
    const result = makeResult(
      [
        { name: "id", type_name: "INT" },
        { name: "note", type_name: "TEXT" },
      ],
      [[1, null]],
    );
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "Enter", altKey: true });

    const dialog = screen.getByRole("dialog", { name: t("gridRowInspectorTitle", { row: 1 }) });
    expect(within(dialog).getByText(t("resultNull"))).toBeInTheDocument();

    fireEvent.keyDown(cells[0][0], { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: t("gridRowInspectorTitle", { row: 1 }) })).toBeNull();
  });
});

// 結果内検索 (Find in Results, #644) の UI 結線テスト。マッチ計算そのものの
// 境界ケースは gridFind.test.ts が固定するので、ここではバーの開閉・ハイライト・
// k/N 表示・Enter/Shift+Enter ナビゲーション・Esc クローズの配線を検証する。
describe("ResultGrid 結果内検索 (#644)", () => {
  beforeEach(() => {
    setLocale("en");
  });

  function renderWithFindOpen() {
    const ref = createRef<ResultGridHandle>();
    const rendered = renderWithProviders(<ResultGrid ref={ref} result={FRUIT_RESULT} />);
    act(() => ref.current!.openFind());
    return { ...rendered, ref };
  }

  it("openFind で検索バーが開き、入力にフォーカスされる", () => {
    renderWithFindOpen();
    const input = screen.getByLabelText(t("gridFindInputAria"));
    expect(input).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
  });

  it("インクリメンタルにヒットをハイライトし k/N を表示する", async () => {
    const user = userEvent.setup();
    const { container } = renderWithFindOpen();

    // "a" は banana / apple の 2 セルにヒットする。
    await user.type(screen.getByLabelText(t("gridFindInputAria")), "a");

    const hits = container.querySelectorAll("td.is-find-hit");
    expect(hits).toHaveLength(2);
    expect(screen.getByText(t("gridFindCount", { current: 1, total: 2 }))).toBeInTheDocument();
    // 先頭ヒットが現在ヒットとして強調される。
    const current = container.querySelector("td.is-find-current");
    expect(current?.textContent).toBe("banana");
  });

  it("Enter / Shift+Enter で次 / 前のヒットへ wrap-around で移動する", async () => {
    const user = userEvent.setup();
    const { container } = renderWithFindOpen();
    const input = screen.getByLabelText(t("gridFindInputAria"));
    await user.type(input, "a");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(container.querySelector("td.is-find-current")?.textContent).toBe("apple");
    expect(screen.getByText(t("gridFindCount", { current: 2, total: 2 }))).toBeInTheDocument();

    // 末尾から次へ → 先頭へ wrap。
    fireEvent.keyDown(input, { key: "Enter" });
    expect(container.querySelector("td.is-find-current")?.textContent).toBe("banana");

    // 先頭から前へ → 末尾へ wrap。
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(container.querySelector("td.is-find-current")?.textContent).toBe("apple");
  });

  it("ヒット 0 件では件数の代わりに『一致なし』を表示する", async () => {
    const user = userEvent.setup();
    renderWithFindOpen();
    await user.type(screen.getByLabelText(t("gridFindInputAria")), "zzz");
    expect(screen.getByText(t("gridFindNoHits"))).toBeInTheDocument();
  });

  it("不正な正規表現はエラーメッセージを表示する", async () => {
    const user = userEvent.setup();
    renderWithFindOpen();
    await user.click(screen.getByRole("button", { name: t("gridFindRegexTitle") }));
    // user-event は "[" をキー記述子の開始と解釈するため "[[" でエスケープする。
    await user.type(screen.getByLabelText(t("gridFindInputAria")), "([[");
    expect(screen.getByText(t("gridFindInvalidRegex"))).toBeInTheDocument();
  });

  it("行を隠さない (列フィルタと違い全行が見えたまま)", async () => {
    const user = userEvent.setup();
    const { container } = renderWithFindOpen();
    await user.type(screen.getByLabelText(t("gridFindInputAria")), "a");
    expect(dataRowTexts(container)).toEqual([
      ["banana", "2"],
      ["apple", "5"],
      ["cherry", "9"],
    ]);
  });

  it("Esc でバーが閉じ、ハイライトが消えてグリッドへフォーカスが戻る", async () => {
    const user = userEvent.setup();
    const { container } = renderWithFindOpen();
    const input = screen.getByLabelText(t("gridFindInputAria"));
    await user.type(input, "a");

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByLabelText(t("gridFindInputAria"))).toBeNull();
    });
    expect(container.querySelectorAll("td.is-find-hit")).toHaveLength(0);
    // 現在ヒットのセルへ DOM フォーカスが移る (グリッドのキーボードナビへ復帰)。
    await waitFor(() => {
      expect((document.activeElement as HTMLElement)?.textContent).toBe("banana");
    });
  });

  it("再オープンでクエリを保持したまま入力を全選択する", async () => {
    const user = userEvent.setup();
    const { ref } = renderWithFindOpen();
    const input = screen.getByLabelText(t("gridFindInputAria"));
    await user.type(input, "a");
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByLabelText(t("gridFindInputAria"))).toBeNull();
    });

    act(() => ref.current!.openFind());
    const input2 = screen.getByLabelText(t("gridFindInputAria")) as HTMLInputElement;
    expect(input2.value).toBe("a");
    expect(document.activeElement).toBe(input2);
  });
});
