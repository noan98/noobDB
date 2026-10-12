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
const CALL_PATTERN = /(?<!`)window(?:\.confirm|\?\.confirm|\[["']confirm["']\])\(/;

// `window.` を付けない素の `confirm(...)` も同じネイティブダイアログを呼ぶ (#1532:
// ConnectionList / SnippetList / SandboxSection に残っていた)。一方 `useConfirm()` が返す
// `confirm` は必ずオブジェクト (`confirm({ ... })`) を取る。引数が `{` で始まらない呼び出しは
// すべて素の confirm とみなして検出する。メンバー呼び出し (`x.confirm(`) と識別子の一部
// (`onConfirm(`) は除く。コメントは検査前に落とす。
// 変数を渡す `confirm(opts)` が正当な箇所だけ許可リストに載せる (理由つき)。
const BARE_CALL_PATTERN = /(?<![\w.$`])confirm\((?!\s*\{)/;
const BARE_CALL_ALLOWLIST: Record<string, string> = {
  "../App.tsx": "useConfirm の confirm(opts) を包む薄いラッパー (オプションをそのまま渡す)",
};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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

  it("no source file calls a bare confirm(...) with a non-object argument (#1532)", () => {
    const offenders: string[] = [];
    for (const [path, content] of Object.entries(modules)) {
      if (path.endsWith("windowConfirmGuard.test.ts")) continue;
      if (path in BARE_CALL_ALLOWLIST) continue;
      if (BARE_CALL_PATTERN.test(stripComments(content))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("BARE_CALL_PATTERN の自己テスト", () => {
    for (const bad of ['confirm("x")', "confirm(msg)", "if (confirm(t('k')))", "confirm(\n  `x`)"]) {
      expect(BARE_CALL_PATTERN.test(bad), bad).toBe(true);
    }
    for (const ok of ["confirm({ title: 'a' })", "await confirm(\n{", "x.confirm(a)", "onConfirm(a)", "`confirm(x)"]) {
      expect(BARE_CALL_PATTERN.test(ok), ok).toBe(false);
    }
  });
});
