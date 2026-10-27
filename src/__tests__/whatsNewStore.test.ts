// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingWhatsNew,
  consumePendingWhatsNew,
  loadLastWhatsNew,
  savePendingWhatsNew,
} from "../whatsNewStore";

beforeEach(() => localStorage.clear());
const upd = { version: "v1.2.0", currentVersion: "1.1.0", body: "## a" };

describe("whatsNewStore (#1864)", () => {
  it("版が一致すれば一度だけ返し、last へ移す", () => {
    savePendingWhatsNew(upd);
    expect(consumePendingWhatsNew("1.2.0")?.body).toBe("## a");
    expect(consumePendingWhatsNew("1.2.0")).toBeNull();
    expect(loadLastWhatsNew()?.version).toBe("v1.2.0");
  });
  it("実行中が古い / 新しいときは破棄して出さない", () => {
    savePendingWhatsNew(upd);
    expect(consumePendingWhatsNew("1.1.0")).toBeNull();
    expect(loadLastWhatsNew()).toBeNull();
    savePendingWhatsNew(upd);
    expect(consumePendingWhatsNew("1.3.0")).toBeNull();
    expect(consumePendingWhatsNew("1.2.0")).toBeNull();
  });
  it("実行中の版が取れないときは持ち越す", () => {
    savePendingWhatsNew(upd);
    expect(consumePendingWhatsNew(null)).toBeNull();
    expect(consumePendingWhatsNew("1.2.0")).not.toBeNull();
  });
  it("ノートは 2000 文字に切り詰め、壊れた JSON は無視、clear で消える", () => {
    savePendingWhatsNew({ ...upd, body: "あ".repeat(3000) });
    expect(consumePendingWhatsNew("1.2.0")?.body.length).toBeLessThanOrEqual(2001);
    localStorage.setItem("noobdb.pendingWhatsNew", "{oops");
    expect(consumePendingWhatsNew("1.2.0")).toBeNull();
    savePendingWhatsNew(upd);
    clearPendingWhatsNew();
    expect(consumePendingWhatsNew("1.2.0")).toBeNull();
  });
});
