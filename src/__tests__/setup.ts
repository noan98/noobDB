// Vitest 共通セットアップ。コンポーネントテスト (React Testing Library) 用に
// jest-dom のカスタムマッチャ (`toBeInTheDocument` 等) を vitest の expect へ
// 拡張し、各テスト後にレンダリング結果を破棄して DOM をクリーンに保つ。
// 純粋ロジックのテストにも読み込まれるが副作用はないため無害。
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// ダイアログ (@zag-js/dialog) はアンマウントで focus-trap を解除し、フォーカス復帰を
// `setTimeout(0)` で遅延実行する (finishDeactivation)。cleanup() 直後にテストが終わると
// このタイマーが jsdom 環境の破棄後に走り、`document is not defined` が未処理エラー
// として報告されて全件テストが失敗扱いになる (#1467)。cleanup 後にマクロタスクを
// 流しきってから次へ進む。段数は zag 側の遅延 1 段 (+ 解除の連鎖に備えて 1 段)。
// fake timers 中は実タイマーを待てない (待つとハングする) ため流さない。
// fake タイマーは環境破棄時に実行されないので、残っていても害はない。
const flushMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  cleanup();
  if (vi.isFakeTimers()) return;
  await flushMacrotask();
  await flushMacrotask();
});
