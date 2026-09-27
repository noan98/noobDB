// SelectableCard (#1161) のホバーリフト回帰テスト。
//
// `ProfileCardGrid` / `WelcomeView` はカードの入場に stagger (#875,
// `variants.staggerItem`) を使う。以前はこの入場アニメを `SelectableCard`
// 自身 (`chakra(motion.button, selectableCardRecipe, {...})`) に直接乗せて
// いたが、Motion は入場完了後もインライン style に `transform: none` を残す。
// これが `selectableCardRecipe` の `_hover`/`&:active` が持つ CSS の
// `transform: translateY(...)` より優先されてしまい、実 Chromium で見ると
// ホバーリフト/押下フィードバックが一切効かない不具合になっていた
// (jsdom は emotion の実スタイルシートも Motion のインライン style も
// レイアウト評価しないため検出できない)。
//
// 修正後は入場を担当する `motion.div` ラッパー (`MotionCardWrap`) と、ホバー/
// 押下を担当する素の `<button>` (`SelectableCard`、CSS transition のみ) を
// 分離しているため、入場アニメが終わってインライン `transform` が残るのは
// ラッパー側だけで、ボタン自身の `transform` に一切触れない。ここでは実
// Chromium で「入場完了後もカードのボタン要素にインライン transform が残って
// いないこと」と「ホバーで CSS の translateY(-1px) リフトが実際に効くこと」を
// 固定する。
import { afterEach, expect, test } from "vitest";
import { cleanup } from "vitest-browser-react";
import { renderInBrowser } from "./render";
import { ProfileCardGrid } from "../../components/ProfileCardGrid";
import { makeProfile } from "../fixtures/componentFixtures";
import { t } from "../../i18n";

afterEach(() => {
  cleanup();
});

// 入場 stagger (staggerTiming: delay 0.04s + each 0.035s) + enter transition
// (durations.base = 0.18s) が確実に終わるまで待つ。`setup.browser.ts` は
// スクリーンショットの決定性のため CSS transition/animation を 0 秒にするが、
// Motion (JS 駆動) の duration はその対象外なので実時間で待つ必要がある。
function waitForEntrance() {
  return new Promise((resolve) => setTimeout(resolve, 500));
}

function renderCards() {
  return renderInBrowser(
    <ProfileCardGrid
      profiles={[makeProfile({ id: "p-a", name: "Alpha DB" })]}
      connectingId={null}
      onConnect={() => {}}
      onCreate={() => {}}
    />,
  );
}

test("入場アニメ完了後もカードのボタンにインライン transform が残らない", async () => {
  const screen = await renderCards();
  await waitForEntrance();

  const card = screen.getByRole("button", { name: "Alpha DB" });
  const el = (await card.element()) as HTMLElement;
  // Motion の入場 (`variants.staggerItem`) は `MotionCardWrap` (ボタンの外側の
  // div) が担当するため、ボタン自身の inline style に Motion 由来の
  // `transform` が残っていてはならない。
  expect(el.style.transform).toBe("");
});

test("ホバーで CSS の translateY(-1px) リフトが実際に効く", async () => {
  const screen = await renderCards();
  await waitForEntrance();

  const card = screen.getByRole("button", { name: "Alpha DB" });
  const el = (await card.element()) as HTMLElement;

  expect(getComputedStyle(el).transform).toBe("none");

  await card.hover();

  // matrix(1, 0, 0, 1, 0, -1) === translateY(-1px)。
  expect(getComputedStyle(el).transform).toBe("matrix(1, 0, 0, 1, 0, -1)");
});

test("新しい接続カードも同じ SelectableCard で描画され、入場後にホバーリフトが効く", async () => {
  const screen = await renderCards();
  await waitForEntrance();

  const createCard = screen.getByRole("button", { name: t("profileCardsNew") });
  const el = (await createCard.element()) as HTMLElement;
  expect(el.style.transform).toBe("");
  expect(getComputedStyle(el).transform).toBe("none");

  await createCard.hover();
  expect(getComputedStyle(el).transform).toBe("matrix(1, 0, 0, 1, 0, -1)");
});
