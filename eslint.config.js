// typescript-eslint (flat config)。高シグナルなルールだけに絞った最小構成 (#1176)。
// スタイル系ルールは入れない。tsc / knip では検出できない「握り潰された Promise」と
// hooks の誤用を機械的に止めるのが目的。
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src-tauri/**", "coverage/**", "e2e/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [tseslint.configs.base],
    languageOptions: {
      // 型情報が必要 (no-floating-promises / no-misused-promises)。
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // await 忘れの IPC 呼び出し = 握り潰された失敗。意図的な fire-and-forget は
      // `void` で明示する (失敗は呼び出し先で処理済みであること)。
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        // `onClick={async () => ...}` は React のイベントハンドラで定着した書き方で、
        // 失敗は各ハンドラ内の try/catch で処理する規約のため属性位置は対象外にする。
        // 引数・プロパティ位置 (コールバックに async を渡す等) は検査を維持する。
        { checksVoidReturn: { attributes: false } },
      ],
      "react-hooks/rules-of-hooks": "error",
      // 既存の依存配列漏れが大量にあり (導入時 78 件)、機械的な修正は stale closure /
      // 再実行ループを生みうるため段階導入にする。`pnpm run lint` の --max-warnings で
      // 件数を固定し、新規の違反は CI で落とす (減らしたら閾値も下げる)。
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
