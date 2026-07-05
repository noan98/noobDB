import { describe, expect, it } from "vitest";

// `window.confirm()` は OS ネイティブの同期ダイアログで、テーマ (ライト/ダーク)・
// アクセント色・フォントサイズに追従せず、フォーカストラップなどの a11y も持たない。
// #280 で `ConfirmDialog.tsx` / `useConfirm()` へ統一済みだが、その後に追加された
// コンポーネントで `window.confirm()` が再導入されるケースが実際にあった (#674)。
// これを防ぐため、src/ 配下のソース全体を静的にスキャンし、実際の呼び出し
// (`window.confirm(`) が無いことを検証する回帰テスト。
//
// ドキュメントコメント中で `` `window.confirm()` `` のように "説明のために言及する"
// ケースは許容したいので、直前がバッククォート (`` ` ``) の場合は除外する
// (negative lookbehind)。
const CALL_PATTERN = /(?<!`)window\.confirm\(/;

const modules = import.meta.glob("../**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("window.confirm regression guard (#674)", () => {
  it("no source file calls window.confirm() directly", () => {
    const offenders: string[] = [];
    for (const [path, content] of Object.entries(modules)) {
      // このテストファイル自身は上記コメント/パターンの文字列表現を含みうるため除外。
      if (path.endsWith("windowConfirmGuard.test.ts")) continue;
      if (CALL_PATTERN.test(content)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });
});
