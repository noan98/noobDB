import { describe, expect, it } from "vitest";
import { renderWithProviders } from "./testUtils";
import { CountUpText } from "../components/CountUp";
import { footerCountUpTarget, type FooterCell } from "../components/gridFooter";
import {
  countUpSlotToken,
  formatCountUpPlainInt,
  integerCountUpTarget,
  splitCountUpTemplate,
} from "../useCountUp";

/**
 * CountUp の横展開 (#1024) の共通ヘルパーのテスト。
 *
 * - どの値をアニメーション対象にしてよいか (`integerCountUpTarget` /
 *   `footerCountUpTarget`) — 大整数の十進文字列や小数・未確定値を除外する
 * - 複数数値を含む i18n 文言の分割 (`splitCountUpTemplate`) — 欠落・重複時は
 *   フォールバックしてトークンを画面へ漏らさない
 */

describe("integerCountUpTarget (#1024)", () => {
  it("安全整数の number だけを対象にする (0 起点・負数・桁数変動を含む)", () => {
    expect(integerCountUpTarget(0)).toBe(0);
    expect(integerCountUpTarget(9)).toBe(9);
    expect(integerCountUpTarget(10_000)).toBe(10_000);
    expect(integerCountUpTarget(-42)).toBe(-42);
    expect(integerCountUpTarget(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("安全整数外・小数・非有限値は対象外 (静的表示)", () => {
    expect(integerCountUpTarget(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(integerCountUpTarget(1.5)).toBeNull();
    expect(integerCountUpTarget(NaN)).toBeNull();
    expect(integerCountUpTarget(Infinity)).toBeNull();
  });

  it("大整数セル値の十進文字列 (lossless デコード) は数値に見えても対象外", () => {
    expect(integerCountUpTarget("9007199254740993")).toBeNull();
    expect(integerCountUpTarget("12")).toBeNull();
    expect(integerCountUpTarget(null)).toBeNull();
    expect(integerCountUpTarget(undefined)).toBeNull();
  });
});

describe("formatCountUpPlainInt (#1024)", () => {
  it("t() の {n} 展開と同じ区切りなし表記で、補間中の小数は丸める", () => {
    expect(formatCountUpPlainInt(1234)).toBe("1234");
    expect(formatCountUpPlainInt(99.6)).toBe("100");
    expect(formatCountUpPlainInt(0)).toBe("0");
  });
});

describe("splitCountUpTemplate (#1024)", () => {
  const a = countUpSlotToken(0);
  const b = countUpSlotToken(1);

  it("2 スロットの文言をテキスト片とスロットに分割する (英語順)", () => {
    expect(splitCountUpTemplate(`rows ${a}–${b}`, 2)).toEqual([
      { kind: "text", text: "rows " },
      { kind: "slot", index: 0 },
      { kind: "text", text: "–" },
      { kind: "slot", index: 1 },
    ]);
  });

  it("スロットの出現順が入れ替わっていても index で対応付ける", () => {
    expect(splitCountUpTemplate(`${b} / ${a}`, 2)).toEqual([
      { kind: "slot", index: 1 },
      { kind: "text", text: " / " },
      { kind: "slot", index: 0 },
    ]);
  });

  it("日本語文言 (末尾テキスト付き)", () => {
    expect(splitCountUpTemplate(`${a}–${b} 行目`, 2)).toEqual([
      { kind: "slot", index: 0 },
      { kind: "text", text: "–" },
      { kind: "slot", index: 1 },
      { kind: "text", text: " 行目" },
    ]);
  });

  it("スロットが欠落・重複しているときは null (フォールバック)", () => {
    expect(splitCountUpTemplate(`rows ${a}`, 2)).toBeNull();
    expect(splitCountUpTemplate(`${a} ${a} ${b}`, 2)).toBeNull();
    expect(splitCountUpTemplate("no tokens", 1)).toBeNull();
  });

  it("トークンは制御文字で挟まれ、スロットごとに異なる", () => {
    expect(a).not.toBe(b);
    expect(a.startsWith("\u0001")).toBe(true);
  });
});

describe("footerCountUpTarget (#1024)", () => {
  const cell = (over: Partial<FooterCell>): FooterCell => ({
    fn: "count",
    numeric: null,
    percent: null,
    blank: false,
    ...over,
  });

  it("確定した整数集計 (count / distinct / 整数の sum) はアニメーション対象", () => {
    expect(footerCountUpTarget(cell({ numeric: 120 }), false)).toBe(120);
    expect(footerCountUpTarget(cell({ fn: "sum", numeric: 0 }), false)).toBe(0);
  });

  it("ストリーミング中 (未確定) は対象外", () => {
    expect(footerCountUpTarget(cell({ numeric: 120 }), true)).toBeNull();
  });

  it("空セル・NULL 率・小数・安全整数外・セル無しは対象外", () => {
    expect(footerCountUpTarget(cell({ blank: true }), false)).toBeNull();
    expect(footerCountUpTarget(cell({ fn: "nullRate", percent: 12.5 }), false)).toBeNull();
    expect(footerCountUpTarget(cell({ fn: "avg", numeric: 2.5 }), false)).toBeNull();
    expect(footerCountUpTarget(cell({ fn: "sum", numeric: 2 ** 60 }), false)).toBeNull();
    expect(footerCountUpTarget(null, false)).toBeNull();
  });
});

describe("CountUpText (#1024)", () => {
  it("各スロットに確定値を描画し、読み上げ用にも確定値を持つ", () => {
    const { container } = renderWithProviders(
      <span data-testid="t">
        <CountUpText values={[101, 200]} render={([f, t]) => `rows ${f}–${t}`} />
      </span>,
    );
    const root = container.querySelector('[data-testid="t"]') as HTMLElement;
    const visible = Array.from(root.querySelectorAll('[aria-hidden="true"]')).map((e) => e.textContent);
    expect(visible).toEqual(["101", "200"]);
    // 見える桁 + 読み上げ用テキストの両方に値が入る (トークンは漏れない)。
    expect(root.textContent).not.toContain("\u0001");
    expect(root.textContent).toContain("rows ");
  });

  it("テンプレートがスロットを落としたときは静的文字列へフォールバックする", () => {
    const { container } = renderWithProviders(
      <span data-testid="t">
        <CountUpText values={[3]} render={() => "Page ?"} />
      </span>,
    );
    const root = container.querySelector('[data-testid="t"]') as HTMLElement;
    expect(root.textContent).toBe("Page ?");
  });
});
