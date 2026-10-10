// Vitest 共通セットアップ。コンポーネントテスト (React Testing Library) 用に
// jest-dom のカスタムマッチャ (`toBeInTheDocument` 等) を vitest の expect へ
// 拡張し、各テスト後にレンダリング結果を破棄して DOM をクリーンに保つ。
// 純粋ロジックのテストにも読み込まれるが副作用はないため無害。
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// ダイアログ (@zag-js/dialog) はアンマウントで focus-trap を解除し、フォーカス復帰を
// `setTimeout(0)` で遅延実行する (finishDeactivation)。cleanup() 直後にテストが終わると
// このタイマーが jsdom 環境の破棄後に走り、`document is not defined` が未処理エラー
// として報告されて全件テストが失敗扱いになる (#1467)。cleanup 後にマクロタスクを 1 つ
// 流しきってから次へ進む (同じ遅延のタイマーは登録順に発火するため 1 段で足りる)。
// 本物の setTimeout は読み込み時に取っておく。fake timers 中も実タイマー側を流せるように
// するため (fake 化された global の setTimeout を待つとハングする)。
// DOM の無い node 環境のテストでは focus-trap が動かないので流さない。
const realSetTimeout = globalThis.setTimeout;
const flushMacrotask = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));

afterEach(async () => {
  cleanup();
  if (typeof document === "undefined") return;
  await flushMacrotask();
});
