import { describe, expect, it } from "vitest";

// モジュールパスの大文字小文字衝突検査。
//
// v0.9.3 のリリースビルド (windows-latest) が `tsc` で落ちた回帰を構造的に塞ぐための
// テスト。`src/components/AccentWash.tsx` (コンポーネント) と
// `src/components/accentWash.ts` (純ロジック) のように**拡張子を除いたパスが大小の
// 違いしかない 2 ファイル**が同居すると、Linux (大小区別あり) では問題なく解決される
// 一方、Windows / macOS の**大小を区別しないファイルシステム**では TypeScript の
// 拡張子探索 (`.ts` → `.tsx` の順) が先に `.ts` を掴むため、`./components/AccentWash`
// が意図した `AccentWash.tsx` ではなく `accentWash.ts` に解決され
// `TS2305 (has no exported member)` / `TS1149` / `TS1261` で型チェックが失敗する。
//
// CI の frontend ジョブは ubuntu で走るため**この失敗は PR 段階では一切見えず**、
// タグを打った後の Windows リリースビルドで初めて表面化した (= 修正してタグを打ち
// 直すまでリリースが出せない、最も遅い検出タイミング)。ここで Linux 上から
// 「衝突しうる命名」そのものを禁止し、PR の時点で落とす。
//
// リポジトリの慣習 (コンポーネント `Foo.tsx` に対し純ロジックは `fooBar.ts` と
// **別の語**を当てる: `ChartView.tsx`/`chartData.ts`、`ERDiagramView.tsx`/`erDiagram.ts`、
// `TitleBar.tsx`/`titleBarContext.ts`) に従っていれば衝突は起きないため、この
// テストはその慣習の機械的な強制でもある。
// 中身は要らずパスだけを見るので、非 eager の glob (値は呼ばれないローダ関数) に
// して全ソースの読み込みを避ける。
const modules = import.meta.glob("../**/*.{ts,tsx}");

/** 拡張子 (`.ts` / `.tsx`) を除いたモジュールパス。import 指定子が指す単位。 */
function stripExtension(path: string): string {
  return path.replace(/\.tsx?$/, "");
}

describe("module path casing", () => {
  it("大小を区別しないファイルシステムで衝突するモジュール名が無い", () => {
    const byLowercased = new Map<string, string[]>();
    for (const path of Object.keys(modules)) {
      const stem = stripExtension(path);
      const key = stem.toLowerCase();
      const bucket = byLowercased.get(key);
      if (bucket) bucket.push(stem);
      else byLowercased.set(key, [stem]);
    }

    const collisions = [...byLowercased.values()]
      .filter((paths) => paths.length > 1)
      .map((paths) => [...paths].sort().join(" <=> "))
      .sort();

    expect(collisions).toEqual([]);
  });

  it("検査対象のモジュールを実際に列挙できている", () => {
    // glob のパターンミスで 0 件になると上のテストが常に通ってしまうため、
    // 検査が空振りしていないことを確認する (パリティテスト群と同じ空振り防止)。
    expect(Object.keys(modules).length).toBeGreaterThan(100);
  });
});
