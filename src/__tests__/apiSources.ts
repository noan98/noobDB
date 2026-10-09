// IPC ラッパーのソース文字列 (パリティテスト用)。
//
// ラッパーは `src/api/tauri.ts` が束ね、本体は `src/api/commands/*.ts` に分かれている
// (並列ブランチの追記衝突を減らすため)。`invoke("name", …)` を文字列として走査する
// テストは 1 ファイルではなくこの連結を読む。`./invoke.ts` などの共通部も含めるため
// `src/api/` 配下をまるごと対象にする (`schemas.ts` は `invoke(` を含まない)。
const sources = import.meta.glob("../api/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const apiWrapperSource: string = Object.keys(sources)
  .sort()
  .map((path) => sources[path])
  .join("\n");
