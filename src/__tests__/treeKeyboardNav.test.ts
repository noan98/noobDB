import { describe, expect, it } from "vitest";
import { resolveTreeArrowLeft, resolveTreeArrowRight, type TreeNavRow } from "../treeKeyboardNav";

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
