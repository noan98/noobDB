import { describe, expect, it } from "vitest";
import {
  nextTreeTypeahead,
  resolveTreeArrowLeft,
  resolveTreeArrowRight,
  resolveTreeExpandSiblings,
  resolveTreeMove,
  resolveTreeTypeahead,
  type TreeNavEntry,
  type TreeNavRow,
} from "../treeKeyboardNav";

/**
 * サイドバーのスキーマツリーの ArrowLeft/ArrowRight 判定 (#1184)。
 * WAI-ARIA Tree パターン: 展開済みノードで → は最初の子へ、折りたたみ済み/葉で
 * ← は親へフォーカスを移す。DOM 非依存の純関数なので `[role=treeitem]` を
 * 上から並べた最小のフィクスチャで固定する。
 */

// 典型的な「DB (レベル1) > テーブル (レベル2, 展開可) > カラム x2 (レベル3, 葉)」の並び。
const dbTableColumns = (tableOpen: boolean): TreeNavRow[] => [
  { level: 1, expandable: true, open: true }, // 0: db (展開済み)
  { level: 2, expandable: true, open: tableOpen }, // 1: table
  { level: 3, expandable: false, open: false }, // 2: col a
  { level: 3, expandable: false, open: false }, // 3: col b
];

describe("resolveTreeArrowRight", () => {
  it("折りたたみ中の展開可能ノードでは開くだけ (toggle) でフォーカスは動かさない", () => {
    const rows = dbTableColumns(false);
    expect(resolveTreeArrowRight(rows, 1)).toEqual({ type: "toggle" });
  });

  it("展開済みノードでは最初の子へフォーカスを移す (move)", () => {
    const rows = dbTableColumns(true);
    expect(resolveTreeArrowRight(rows, 1)).toEqual({ type: "move", index: 2 });
  });

  it("展開済みでも子が無ければ何もしない", () => {
    const rows: TreeNavRow[] = [{ level: 1, expandable: true, open: true }];
    expect(resolveTreeArrowRight(rows, 0)).toBeNull();
  });

  it("葉ノード (展開不可) では何もしない", () => {
    const rows = dbTableColumns(true);
    expect(resolveTreeArrowRight(rows, 2)).toBeNull();
  });

  it("末尾の展開済みノードの直後に、より深い行が無い場合は何もしない", () => {
    // db (展開済みだが子がゼロ件、次行は同階層の兄弟)。
    const rows: TreeNavRow[] = [
      { level: 1, expandable: true, open: true },
      { level: 1, expandable: true, open: false },
    ];
    expect(resolveTreeArrowRight(rows, 0)).toBeNull();
  });
});

describe("resolveTreeArrowLeft", () => {
  it("展開済みノードでは閉じるだけ (toggle) でフォーカスは動かさない", () => {
    const rows = dbTableColumns(true);
    expect(resolveTreeArrowLeft(rows, 1)).toEqual({ type: "toggle" });
  });

  it("折りたたみ中のノードでは親へフォーカスを移す (move)", () => {
    const rows = dbTableColumns(false);
    expect(resolveTreeArrowLeft(rows, 1)).toEqual({ type: "move", index: 0 });
  });

  it("葉ノードでは直近の祖先 (テーブル) へフォーカスを移す", () => {
    const rows = dbTableColumns(true);
    // カラム b (index 3) の直近の祖先はテーブル (index 1)。db (index 0) ではない。
    expect(resolveTreeArrowLeft(rows, 3)).toEqual({ type: "move", index: 1 });
  });

  it("ルート直下の項目 (祖先が無い) では何もしない", () => {
    // ルート直下の葉ノード (例: クイックアクセス行) には親が無い。
    const rows: TreeNavRow[] = [{ level: 1, expandable: false, open: false }];
    expect(resolveTreeArrowLeft(rows, 0)).toBeNull();
  });

  it("兄弟をまたいでも同階層以上を飛び越えて正しい親を見つける", () => {
    // グループ (レベル1) > プロファイル (レベル2) > db (レベル3、閉じている)。
    const rows: TreeNavRow[] = [
      { level: 1, expandable: true, open: true },
      { level: 2, expandable: true, open: true },
      { level: 3, expandable: true, open: false },
    ];
    expect(resolveTreeArrowLeft(rows, 2)).toEqual({ type: "move", index: 1 });
  });
});

describe("resolveTreeMove (#1315)", () => {
  const entry = (label: string): TreeNavEntry => ({ level: 1, expandable: false, open: false, label });
  const entries = ["alpha", "Beta", "gamma", "beam"].map(entry);

  it("↓ は次の行へ、末尾では動かない (循環しない)", () => {
    expect(resolveTreeMove(entries, 0, "ArrowDown")).toBe(1);
    expect(resolveTreeMove(entries, 3, "ArrowDown")).toBeNull();
  });

  it("↑ は前の行へ、先頭では動かない", () => {
    expect(resolveTreeMove(entries, 2, "ArrowUp")).toBe(1);
    expect(resolveTreeMove(entries, 0, "ArrowUp")).toBeNull();
  });

  it("Home / End は先頭 / 末尾 (窓の外でも配列の端)", () => {
    expect(resolveTreeMove(entries, 2, "Home")).toBe(0);
    expect(resolveTreeMove(entries, 1, "End")).toBe(3);
  });

  it("先頭文字ジャンプは現在行の次から探し、大文字小文字を区別せず、末尾から先頭へ折り返す", () => {
    expect(resolveTreeMove(entries, 0, "b")).toBe(1);
    expect(resolveTreeMove(entries, 1, "b")).toBe(3);
    // 末尾の beam から探すと、先頭側の Beta へ折り返す。
    expect(resolveTreeMove(entries, 3, "B")).toBe(1);
    // 現在行しか一致しないときは、自分自身に戻る (1 周する)。
    expect(resolveTreeMove(entries, 2, "g")).toBe(2);
  });

  it("一致が無い文字や印字できないキーは null", () => {
    expect(resolveTreeMove(entries, 0, "z")).toBeNull();
    expect(resolveTreeMove(entries, 0, "Tab")).toBeNull();
    expect(resolveTreeMove([], 0, "ArrowDown")).toBeNull();
  });

  it("現在行が不明 (-1) のときは、↓ と先頭文字は先頭から、↑ は末尾から", () => {
    expect(resolveTreeMove(entries, -1, "ArrowDown")).toBe(0);
    expect(resolveTreeMove(entries, -1, "ArrowUp")).toBe(3);
    expect(resolveTreeMove(entries, -1, "g")).toBe(2);
  });
});

describe("複数文字の先頭文字ジャンプ (#1629)", () => {
  const entry = (label: string): TreeNavEntry => ({ level: 1, expandable: false, open: false, label });
  const entries = ["orders", "users", "user_roles", "uploads", "events"].map(entry);

  it("入力バッファは時間内なら連結し、空くと打ち直しになる", () => {
    const a = nextTreeTypeahead(null, "U", 1000);
    expect(a).toEqual({ text: "u", at: 1000 });
    expect(nextTreeTypeahead(a, "s", 1500)).toEqual({ text: "us", at: 1500 });
    expect(nextTreeTypeahead(a, "s", 1000 + 801)).toEqual({ text: "s", at: 1801 });
    // 時刻が巻き戻ったときも連結しない。
    expect(nextTreeTypeahead(a, "s", 900)).toEqual({ text: "s", at: 900 });
  });

  it("2 文字以上は現在行を含めて前方一致を探す", () => {
    // 現在 users で "us" と続けても動かない。
    expect(resolveTreeTypeahead(entries, 1, "us")).toBe(1);
    // "use" ならどちらも一致 → 現在 users のまま、"user_" なら user_roles へ。
    expect(resolveTreeTypeahead(entries, 1, "user_")).toBe(2);
    expect(resolveTreeTypeahead(entries, 0, "up")).toBe(3);
    // 末尾から先頭へ折り返す。
    expect(resolveTreeTypeahead(entries, 4, "or")).toBe(0);
  });

  it("1 文字と同じ文字の繰り返しは、現在行の次から巡回する", () => {
    expect(resolveTreeTypeahead(entries, 1, "u")).toBe(2);
    expect(resolveTreeTypeahead(entries, 1, "uu")).toBe(2);
    expect(resolveTreeTypeahead(entries, 3, "u")).toBe(1);
  });

  it("一致が無いとき・空バッファは null", () => {
    expect(resolveTreeTypeahead(entries, 0, "zz9")).toBeNull();
    expect(resolveTreeTypeahead(entries, 0, "")).toBeNull();
    expect(resolveTreeTypeahead([], 0, "u")).toBeNull();
  });

  it("resolveTreeMove の 1 文字ジャンプは従来どおり", () => {
    expect(resolveTreeMove(entries, 1, "u")).toBe(2);
  });
});

describe("* で兄弟を一括展開 (#1629)", () => {
  const row = (level: number, expandable: boolean, open: boolean): TreeNavRow => ({
    level,
    expandable,
    open,
  });
  // db1 (open) > t1(閉), t2(開) > col, t3(閉) ; db2 (閉)
  const rows: TreeNavRow[] = [
    row(1, true, true),
    row(2, true, false),
    row(2, true, true),
    row(3, false, false),
    row(2, true, false),
    row(2, false, false),
    row(1, true, false),
  ];

  it("同じ親の同じ階層で、閉じている展開可能ノードの位置を返す", () => {
    expect(resolveTreeExpandSiblings(rows, 1)).toEqual([1, 4]);
    expect(resolveTreeExpandSiblings(rows, 4)).toEqual([1, 4]);
  });

  it("ルート階層では別の親の下の行を含めない", () => {
    expect(resolveTreeExpandSiblings(rows, 0)).toEqual([6]);
  });

  it("範囲外・展開できる兄弟が無いときは空", () => {
    expect(resolveTreeExpandSiblings(rows, 99)).toEqual([]);
    expect(resolveTreeExpandSiblings([row(1, false, false)], 0)).toEqual([]);
  });
});
