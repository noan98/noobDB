// Vitest 共通セットアップ。コンポーネントテスト (React Testing Library) 用に
// jest-dom のカスタムマッチャ (`toBeInTheDocument` 等) を vitest の expect へ
// 拡張し、各テスト後にレンダリング結果を破棄して DOM をクリーンに保つ。
// 純粋ロジックのテストにも読み込まれるが副作用はないため無害。
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
