// @vitest-environment jsdom (DOM の属性付与と animationend を確かめるため)
import { afterEach, describe, expect, it, vi } from "vitest";
import { rejectSubmit } from "../components/submitRejectFeedback";

function make(withAlert = false): HTMLElement {
  const el = document.createElement("div");
  if (withAlert) {
    const a = document.createElement("p");
    a.setAttribute("role", "alert");
    a.scrollIntoView = vi.fn();
    el.appendChild(a);
  }
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-motion");
});

describe("rejectSubmit (#1831)", () => {
  it("属性を付け、animationend で外す", () => {
    const el = make();
    rejectSubmit(el);
    expect(el).toHaveAttribute("data-submit-rejected");
    el.dispatchEvent(new Event("animationend"));
    expect(el).not.toHaveAttribute("data-submit-rejected");
  });

  it("連続呼び出しでも listener が重複せず、1 回の animationend で外れる", () => {
    const el = make();
    const add = vi.spyOn(el, "addEventListener");
    rejectSubmit(el);
    rejectSubmit(el);
    rejectSubmit(el);
    el.dispatchEvent(new Event("animationend"));
    expect(el).not.toHaveAttribute("data-submit-rejected");
    // 外した後は購読も無い: 付け直しても古い購読が残らない。
    rejectSubmit(el);
    expect(el).toHaveAttribute("data-submit-rejected");
    expect(add.mock.calls.filter(([t]) => t === "animationend").length).toBe(4);
  });

  it("付け直し直後の animationcancel (古いアニメの cancel) では外さない", () => {
    const el = make();
    el.getAnimations = (() => [{}]) as unknown as HTMLElement["getAnimations"];
    rejectSubmit(el);
    el.dispatchEvent(new Event("animationcancel"));
    expect(el).toHaveAttribute("data-submit-rejected");
    el.getAnimations = (() => []) as unknown as HTMLElement["getAnimations"];
    el.dispatchEvent(new Event("animationcancel"));
    expect(el).not.toHaveAttribute("data-submit-rejected");
  });

  it("role=alert があれば scrollIntoView を呼ぶ。抑制時も呼ぶが属性は付けない", () => {
    const el = make(true);
    const alert = el.querySelector<HTMLElement>('[role="alert"]');
    rejectSubmit(el);
    expect(alert?.scrollIntoView).toHaveBeenCalledTimes(1);
    el.dispatchEvent(new Event("animationend"));
    document.documentElement.setAttribute("data-motion", "reduced");
    rejectSubmit(el);
    expect(alert?.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(el).not.toHaveAttribute("data-submit-rejected");
  });
});
