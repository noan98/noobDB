import { describe, expect, it } from "vitest";
import vectors from "./fixtures/pgListenChannelVectors.json";
import {
  appendNotification,
  channelCaseWarning,
  checkChannelName,
  foldUnquotedChannel,
  countByChannel,
  formatReceivedAt,
  payloadPreview,
  pendingCount,
  pgListenReasonKey,
  prettyJsonPayload,
  supportsPgListen,
  visibleNotifications,
  type BufferedNotification,
} from "../components/pgListen";

const note = (seq: number): BufferedNotification => ({
  seq,
  channel: "c",
  payload: String(seq),
  payloadTruncated: false,
  pid: 1,
  receivedAtMs: seq,
});

describe("appendNotification (#2019)", () => {
  it("上限内ならそのまま末尾に足す", () => {
    const { items, dropped } = appendNotification([note(1)], note(2), 3);
    expect(items.map((n) => n.seq)).toEqual([1, 2]);
    expect(dropped).toBe(0);
  });

  it("上限を超えたら古い通知から捨てる", () => {
    let buf: BufferedNotification[] = [];
    let totalDropped = 0;
    for (let i = 1; i <= 5; i++) {
      const r = appendNotification(buf, note(i), 3);
      buf = r.items;
      totalDropped += r.dropped;
    }
    expect(buf.map((n) => n.seq)).toEqual([3, 4, 5]);
    expect(totalDropped).toBe(2);
  });

  it("元の配列を書き換えない", () => {
    const before = [note(1), note(2)];
    appendNotification(before, note(3), 2);
    expect(before.map((n) => n.seq)).toEqual([1, 2]);
  });
});

describe("checkChannelName (#2019)", () => {
  it("前後の空白を落として通す (内部の空白・引用符・大文字はそのまま)", () => {
    expect(checkChannelName("  Orders Changed  ")).toEqual({ ok: true, name: "Orders Changed" });
    expect(checkChannelName('a"b; DROP TABLE t; --')).toEqual({ ok: true, name: 'a"b; DROP TABLE t; --' });
  });

  it("空・NUL・63 バイト超を弾く", () => {
    expect(checkChannelName("   ")).toEqual({ ok: false, problem: "empty" });
    expect(checkChannelName("a\0b")).toEqual({ ok: false, problem: "nul" });
    expect(checkChannelName("x".repeat(63)).ok).toBe(true);
    expect(checkChannelName("x".repeat(64))).toEqual({ ok: false, problem: "tooLong" });
  });

  it("長さはバイトで数える (日本語は 1 文字 3 バイト)", () => {
    expect(checkChannelName("あ".repeat(21)).ok).toBe(true);
    expect(checkChannelName("あ".repeat(22))).toEqual({ ok: false, problem: "tooLong" });
  });
});

describe("チャンネル名の共有ゴールデンベクタ (#2132)", () => {
  it("Rust の validate_channel と同じ判定・畳み込みになる", () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
    for (const c of vectors.cases) {
      const got = checkChannelName(c.raw);
      if (c.ok) {
        expect(got, c.name).toEqual({ ok: true, name: c.channel });
        expect(foldUnquotedChannel(c.channel as string), c.name).toBe(c.folded);
      } else {
        expect(got, c.name).toEqual({ ok: false, problem: c.problem });
      }
    }
  });
});

describe("channelCaseWarning (#2132)", () => {
  it("大文字を含む有効な名前だけ、畳んだ名前つきで注意を返す", () => {
    expect(channelCaseWarning("OrdersChanged")).toEqual({
      name: "OrdersChanged",
      folded: "orderschanged",
    });
    expect(channelCaseWarning("  Orders ")).toEqual({ name: "Orders", folded: "orders" });
    expect(channelCaseWarning("orders_changed")).toBeNull();
    // 非 ASCII は PostgreSQL も畳まないので注意しない。
    expect(channelCaseWarning("日本語")).toBeNull();
  });

  it("無効な名前 (空・長すぎ) には出さない (エラーが先に出る)", () => {
    expect(channelCaseWarning("")).toBeNull();
    expect(channelCaseWarning(`A${"x".repeat(63)}`)).toBeNull();
  });
});

describe("縮退と表示の補助 (#2019)", () => {
  it("PostgreSQL だけが対応", () => {
    expect(supportsPgListen("postgres")).toBe(true);
    expect(supportsPgListen("mysql")).toBe(false);
    expect(supportsPgListen("sqlite")).toBe(false);
    expect(supportsPgListen(null)).toBe(false);
  });

  it("理由コードを説明文のキーに対応づける", () => {
    expect(pgListenReasonKey("unsupported_driver")).toBe("pgListenReasonUnsupportedDriver");
    expect(pgListenReasonKey("something_new")).toBe("pgListenReasonUnknown");
  });

  it("payload の一覧表示は空白を畳み、長いものを省略する", () => {
    expect(payloadPreview("a\n  b")).toBe("a b");
    expect(payloadPreview("x".repeat(10), 4)).toBe("xxxx…");
    expect(payloadPreview("あいうえお", 3)).toBe("あいう…");
  });

  it("JSON の payload だけ整形する", () => {
    expect(prettyJsonPayload('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJsonPayload("plain")).toBeNull();
    expect(prettyJsonPayload("{broken")).toBeNull();
  });

  it("受信時刻を HH:MM:SS.mmm にする", () => {
    const d = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(formatReceivedAt(d.getTime())).toBe("03:04:05.006");
  });
});

describe("表示一時停止とチャンネル別件数 (#2093)", () => {
  const mk = (seq: number, channel: string): BufferedNotification => ({
    seq,
    channel,
    payload: "",
    payloadTruncated: false,
    pid: 1,
    receivedAtMs: seq,
  });
  const items = [mk(1, "a"), mk(2, "b"), mk(3, "a"), mk(4, "a")];

  it("一時停止中はスナップショットを見せ、件数は凍結点より後をバッファから数える", () => {
    expect(visibleNotifications(items, null).map((n) => n.seq)).toEqual([1, 2, 3, 4]);
    const snap = items.filter((n) => n.seq <= 2);
    expect(visibleNotifications(items, snap).map((n) => n.seq)).toEqual([1, 2]);
    expect(pendingCount(items, null)).toBe(0);
    expect(pendingCount(items, 2)).toBe(2);
    expect(pendingCount(items, 2, "a")).toBe(2);
    expect(pendingCount(items, 2, "b")).toBe(0);
  });

  it("バッファが上限を超えて古い通知を捨てても、停止中の表示は変わらない", () => {
    let buf: BufferedNotification[] = [];
    for (let i = 1; i <= 3; i++) buf = appendNotification(buf, mk(i, "a"), 3).items;
    const snap = buf;
    for (let i = 4; i <= 9; i++) buf = appendNotification(buf, mk(i, "a"), 3).items;
    expect(buf.map((n) => n.seq)).toEqual([7, 8, 9]);
    expect(visibleNotifications(buf, snap).map((n) => n.seq)).toEqual([1, 2, 3]);
    expect(pendingCount(buf, 3)).toBe(3);
  });

  it("チャンネル別に数える", () => {
    expect([...countByChannel(items)]).toEqual([
      ["a", 3],
      ["b", 1],
    ]);
  });
});
