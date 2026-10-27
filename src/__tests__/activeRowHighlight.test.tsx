import { afterEach, describe, expect, it } from "vitest";
import { activeRowTransition } from "../components/ActiveRowHighlight";
import { transitions } from "../motion";

describe("activeRowTransition (#1876)", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("通常テーマでは共有の emphasized プリセットを使う", () => {
    expect(activeRowTransition()).toBe(transitions.emphasized);
  });

  it("ハイコントラストテーマでは瞬時 (duration: 0) にする", () => {
    document.documentElement.setAttribute("data-theme", "hc-dark");
    expect(activeRowTransition()).toEqual({ duration: 0 });
  });
});
