// Vitest ブラウザモード共通セットアップ。実ブラウザ (Playwright + headless
// Chromium) 上で主要画面を描画・検証するテスト群で読み込まれる。jsdom 版の
// `setup.ts` とは実行環境が異なるため別ファイルに分けている。
//
// やること:
//   0. デザイントークン (`App.css`) の読み込み — 実アプリは `main.tsx` が
//      `App.css` を import してから `ChakraProvider` をマウントするが、ブラウザ
//      テストのハーネスは `main.tsx` を経由しないため、`App.css` が一度も
//      読み込まれず `:root` の CSS 変数 (`--font-scale` / `--text-*` /
//      `--control-*` / `--bg` ほか) が全て未定義のまま描画されていた (#961)。
//      Chakra の recipe (`buttonRecipe` の `px: "var(--control-px)"` 等) は
//      これらの変数を参照するため、未定義のままだと padding/gap/font-size が
//      潰れ、`calc(13px * var(--font-scale))` (`Icon.tsx`) のような式も invalid
//      になってアイコンが巨大化する。実アプリと同じ読み込み順
//      (`main.tsx` → `App.css` → `ChakraProvider`) に揃えるため、他のセットアップ
//      (アニメーション無効化 CSS の注入など) より前に import する。jsdom 側
//      (`testUtils.tsx`) は computed style を評価しないため影響を受けない。
//   1. Tauri ランタイムのスタブ — 実ブラウザには Tauri が注入する
//      `window.__TAURI_INTERNALS__` が存在しないため、`@tauri-apps/api` の
//      `invoke` がそのままだと参照エラーになる。コンポーネントがマウント時に
//      誤って IPC を呼んでも描画が壊れないよう、無害なスタブを用意する。テストは
//      原則として props でデータを注入する (実 DB に依存しない) ため、ここでは
//      「呼ばれても落ちない」ことだけを保証すればよい。これは jsdom テスト群と
//      共有する `src/api/tauri.ts` のモックシームと同じ発想で、実 DB なしに任意の
//      画面状態を流し込めるという設計上の利点を活用している。
//   2. アニメーション無効化 — `motion` のトランジションやスピナーの回転が走ると
//      ビジュアル回帰スクリーンショットが非決定的になる。`prefers-reduced-motion`
//      相当として全要素のアニメーション/トランジションを停止する CSS を注入する。
//   3. ロケール固定 — 描画される文言を決定的にするため英語に固定する。
import "../../App.css";
import { afterEach, beforeEach } from "vitest";
import { cleanup } from "vitest-browser-react";
import { setLocale } from "../../i18n";

// `window.__TAURI_INTERNALS__` のグローバル型は `tauriMock.ts` 側で宣言している
// (シナリオテストが同じプロパティをフル機能のフェイクランタイムで上書きするため、
// 宣言を一本化している)。ここでは最小スタブを入れるだけ。

// 1. Tauri ランタイムのスタブ。`invoke` は常に解決済み Promise を返し、IPC を
//    呼ぶコンポーネントがあってもレンダリングを妨げない。イベント購読
//    (`plugin:event|listen`) も同様に無害化する。
if (!window.__TAURI_INTERNALS__) {
  let callbackId = 0;
  window.__TAURI_INTERNALS__ = {
    invoke: () => Promise.resolve(null),
    transformCallback: () => {
      callbackId += 1;
      return callbackId;
    },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
  };
}

// 2. アニメーション無効化。スクリーンショットの決定性を確保する。
const style = document.createElement("style");
style.setAttribute("data-test-disable-animations", "");
style.textContent = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
  }
`;
document.head.appendChild(style);

// 3. ロケールを英語に固定 (各テスト前に再設定して取りこぼしを防ぐ)。
beforeEach(() => {
  setLocale("en");
});

// 各テスト後にマウント結果を破棄する。Portal (Modal) を含むコンポーネントが
// document.body 直下に残ると、後続テストの `getByRole("dialog")` が複数一致して
// 落ちるため、明示的にクリーンアップして DOM をまっさらに保つ。
afterEach(() => {
  cleanup();
});
