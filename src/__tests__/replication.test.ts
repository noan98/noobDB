import { describe, expect, it } from "vitest";
import type { ReplicationLink, ReplicationSlot } from "../api/tauri";
import { diffLiveRows } from "../components/liveDiff";
import {
  appendReplicationHistory,
  buildDropSlotSql,
  EMPTY_REPLICATION_HISTORY,
  edgeThickness,
  layoutTopology,
  pushSample,
  sampleDelta,
  summarizeReplication,
  topologyLagLevel,
  TOPOLOGY_MAX_PER_SIDE,
  dropSlotBlockedReason,
  formatLagSecs,
  isLagWarning,
  LAG_METER_MAX_SECS,
  LAG_WARN_SECS,
  lagMeterPercent,
  lagWarnPercent,
  linkKey,
  linkKeys,
  keyLinks,
  linkNeedsAttention,
  REPLICATION_LINK_LIVE_FIELDS,
  REPLICATION_SLOT_LIVE_FIELDS,
  slotKey,
  SLOT_WAL_WARN_BYTES,
  slotsHoldingWal,
  slotsLost,
  sortLinks,
} from "../components/replication";

const slot = (over: Partial<ReplicationSlot>): ReplicationSlot => ({
  name: "s",
  slot_type: "logical",
  plugin: null,
  active: false,
  retained_bytes: 0,
  wal_status: null,
  ...over,
});

const link = (over: Partial<ReplicationLink>): ReplicationLink => ({
  direction: "downstream",
  name: "r",
  address: null,
  state: null,
  sync_state: null,
  lag_secs: null,
  write_lag_secs: null,
  flush_lag_secs: null,
  lag_bytes: null,
  io_running: null,
  sql_running: null,
  last_error: null,
  ...over,
});

describe("slotsHoldingWal (#2180)", () => {
  it("警告の閾値は 1 GiB", () => {
    expect(SLOT_WAL_WARN_BYTES).toBe(1024 ** 3);
  });

  it("非アクティブで閾値以上を保持するスロットだけを、保持量の多い順に返す", () => {
    const got = slotsHoldingWal([
      slot({ name: "small", retained_bytes: SLOT_WAL_WARN_BYTES - 1 }),
      slot({ name: "edge", retained_bytes: SLOT_WAL_WARN_BYTES }),
      slot({ name: "big", retained_bytes: SLOT_WAL_WARN_BYTES * 5 }),
      slot({ name: "busy", active: true, retained_bytes: SLOT_WAL_WARN_BYTES * 9 }),
      slot({ name: "unknown", retained_bytes: null }),
    ]);
    expect(got.map((s) => s.name)).toEqual(["big", "edge"]);
  });

  it("閾値は引数で変えられる", () => {
    expect(slotsHoldingWal([slot({ name: "a", retained_bytes: 10 })], 10)).toHaveLength(1);
    expect(slotsHoldingWal([slot({ name: "a", retained_bytes: 9 })], 10)).toHaveLength(0);
  });
});

describe("遅延メーター (#2180)", () => {
  it("0〜100% に収め、未報告・負値・非有限値は 0", () => {
    expect(lagMeterPercent(null)).toBe(0);
    expect(lagMeterPercent(undefined)).toBe(0);
    expect(lagMeterPercent(-3)).toBe(0);
    expect(lagMeterPercent(Number.NaN)).toBe(0);
    expect(lagMeterPercent(LAG_METER_MAX_SECS / 2)).toBe(50);
    expect(lagMeterPercent(LAG_METER_MAX_SECS * 10)).toBe(100);
  });

  it("警告マーカーの位置は閾値 / 目盛り上限", () => {
    expect(lagWarnPercent()).toBe((LAG_WARN_SECS / LAG_METER_MAX_SECS) * 100);
  });

  it("警告は閾値ちょうどから", () => {
    expect(isLagWarning(LAG_WARN_SECS - 0.1)).toBe(false);
    expect(isLagWarning(LAG_WARN_SECS)).toBe(true);
    expect(isLagWarning(null)).toBe(false);
  });
});

describe("formatLagSecs", () => {
  it("秒・分秒・時分に整形する", () => {
    expect(formatLagSecs(0)).toBe("0.0 s");
    expect(formatLagSecs(1.25)).toBe("1.3 s");
    expect(formatLagSecs(42)).toBe("42 s");
    expect(formatLagSecs(125)).toBe("2m 5s");
    expect(formatLagSecs(3 * 3600 + 120)).toBe("3h 2m");
    expect(formatLagSecs(-1)).toBe("—");
  });
});

describe("接続先の注意判定と並び", () => {
  it("停止中のスレッド・エラー・遅延超過があれば注意", () => {
    expect(linkNeedsAttention(link({}))).toBe(false);
    expect(linkNeedsAttention(link({ io_running: true, sql_running: true }))).toBe(false);
    expect(linkNeedsAttention(link({ io_running: false }))).toBe(true);
    expect(linkNeedsAttention(link({ sql_running: false }))).toBe(true);
    expect(linkNeedsAttention(link({ last_error: "boom" }))).toBe(true);
    expect(linkNeedsAttention(link({ lag_secs: LAG_WARN_SECS }))).toBe(true);
  });

  it("PostgreSQL の受信停止 (io_running = false・遅延は 0 のまま) を注意にする (#2244)", () => {
    const stopped = link({
      direction: "upstream",
      state: "no_receiver",
      lag_secs: 0,
      io_running: false,
    });
    expect(linkNeedsAttention(stopped)).toBe(true);
    // 権限不足 (io_running = null) で遅延 0 は従来どおり正常。
    expect(linkNeedsAttention(link({ direction: "upstream", lag_secs: 0, io_running: null }))).toBe(false);
    // 平常時 (streaming・遅延 0) は正常のまま。
    expect(
      linkNeedsAttention(link({ direction: "upstream", state: "streaming", lag_secs: 0, io_running: true })),
    ).toBe(false);
  });

  it("要約は受信停止の接続先を数え、トポロジーは注意ノードにする (#2244)", () => {
    const stopped = link({ direction: "upstream", name: "p", lag_secs: 0, io_running: false });
    expect(summarizeReplication([stopped], []).attentionLinks).toBe(1);
    const layout = layoutTopology(keyLinks([stopped]));
    expect(layout.upstream[0].attention).toBe(true);
  });

  it("注意が要る行を先頭に、あとは名前順", () => {
    const got = sortLinks([link({ name: "b" }), link({ name: "z", last_error: "x" }), link({ name: "a" })]);
    expect(got.map((l) => l.name)).toEqual(["z", "a", "b"]);
  });
});

describe("slotsLost", () => {
  it("wal_status が lost のスロットだけを返す", () => {
    const got = slotsLost([
      slot({ name: "a", wal_status: "lost" }),
      slot({ name: "b", wal_status: "reserved" }),
      slot({ name: "c", wal_status: null }),
    ]);
    expect(got.map((x) => x.name)).toEqual(["a"]);
  });
});

describe("buildDropSlotSql (#2180)", () => {
  it("スロット名は文字列リテラルとして入り、' は '' に重ねる", () => {
    expect(buildDropSlotSql("my_slot")).toBe("SELECT pg_drop_replication_slot('my_slot')");
    expect(buildDropSlotSql("a'b")).toBe("SELECT pg_drop_replication_slot('a''b')");
    // 注入を試みる名前も、1 つの文字列リテラルに閉じ込められる。
    expect(buildDropSlotSql("x'); DROP TABLE t; --")).toBe(
      "SELECT pg_drop_replication_slot('x''); DROP TABLE t; --')",
    );
    expect(buildDropSlotSql("''")).toBe(`SELECT pg_drop_replication_slot('${"'".repeat(4)}')`);
  });
});

describe("dropSlotBlockedReason", () => {
  it("読み取り専用 → 使用中 → 削除可の順に理由を返す", () => {
    expect(dropSlotBlockedReason(slot({ active: false }), true)).toBe("readOnly");
    expect(dropSlotBlockedReason(slot({ active: true }), false)).toBe("active");
    expect(dropSlotBlockedReason(slot({ active: false }), false)).toBeNull();
  });
});

describe("linkKey / 値変化フラッシュ (#2213)", () => {
  it("key は並び順に依存せず、向き・名前・アドレスで一意になる", () => {
    const a = link({ name: "a", address: "10.0.0.1" });
    const b = link({ name: "b", address: "10.0.0.2", lag_secs: 99 });
    const before = [a, b].map(linkKey);
    // 異常のある b が先頭へ並べ替わっても、同じ接続先の key は変わらない。
    const after = sortLinks([a, b]).map(linkKey);
    expect(after).toEqual([before[1], before[0]]);
    expect(linkKey(link({ name: "a", address: "x", direction: "upstream" }))).not.toBe(
      linkKey(link({ name: "a", address: "x", direction: "downstream" })),
    );
    expect(linkKey(link({ name: "a", address: null }))).not.toBe(
      linkKey(link({ name: "a", address: "" + "z" })),
    );
    // 区切りが曖昧にならない (name に ":" を含んでも衝突しない)。
    expect(linkKey(link({ name: "a:b", address: "c" }))).not.toBe(
      linkKey(link({ name: "a", address: "b:c" })),
    );
  });

  it("遅延と WAL 差分が変わった接続先だけ、変わったフィールドを返す", () => {
    const prev = [link({ name: "a", lag_secs: 1, lag_bytes: 10 }), link({ name: "b", lag_secs: 2 })];
    const next = [link({ name: "a", lag_secs: 3, lag_bytes: 10 }), link({ name: "b", lag_secs: 2 })];
    const changes = diffLiveRows(keyLinks(prev), keyLinks(next), (l) => l.key, REPLICATION_LINK_LIVE_FIELDS);
    expect([...changes.keys()]).toEqual([linkKey(next[0])]);
    expect([...(changes.get(linkKey(next[0])) ?? [])]).toEqual(["lag"]);
  });

  it("null との行き来も変化とみなし、初回 (前回なし) は光らない", () => {
    const a = link({ name: "a", write_lag_secs: null });
    const b = link({ name: "a", write_lag_secs: 0 });
    expect(diffLiveRows(keyLinks([a]), keyLinks([b]), (l) => l.key, REPLICATION_LINK_LIVE_FIELDS).size).toBe(
      1,
    );
    expect(diffLiveRows(null, keyLinks([b]), (l) => l.key, REPLICATION_LINK_LIVE_FIELDS).size).toBe(0);
    expect(diffLiveRows([], keyLinks([b]), (l) => l.key, REPLICATION_LINK_LIVE_FIELDS).size).toBe(0);
  });

  it("スロットは名前で突き合わせ、WAL 保持量の変化だけ返す", () => {
    const prev = [slot({ name: "s1", retained_bytes: 1 }), slot({ name: "s2", retained_bytes: 5 })];
    const next = [slot({ name: "s2", retained_bytes: 5 }), slot({ name: "s1", retained_bytes: 2 })];
    const changes = diffLiveRows(prev, next, slotKey, REPLICATION_SLOT_LIVE_FIELDS);
    expect([...changes.keys()]).toEqual(["s1"]);
  });
});

describe("linkKeys (#2213)", () => {
  it("重複しない一覧は linkKey のまま、重複したときだけ出現順の連番を足す", () => {
    const a = link({ name: "walsender", address: null });
    const b = link({ name: "other", address: "x" });
    expect(linkKeys([a, b])).toEqual([linkKey(a), linkKey(b)]);
    const keys = linkKeys([a, b, { ...a }, { ...a }]);
    expect(new Set(keys).size).toBe(4);
    expect(keys[0]).toBe(linkKey(a));
    expect(keys[2]).toBe(`${linkKey(a)}#1`);
    expect(keys[3]).toBe(`${linkKey(a)}#2`);
  });

  it("並べ替えても同じ接続先は同じ key を保ち、接続先は消えない", () => {
    const dup1 = link({ name: "ws", lag_secs: 99 });
    const dup2 = link({ name: "ws", lag_secs: 1 });
    const keyed = keyLinks([dup2, dup1]);
    expect(keyed).toHaveLength(2);
    const sorted = sortLinks(keyed);
    // 異常のある dup1 (key は #1) が先頭へ移っても key は元のまま。
    expect(sorted.map((l) => l.key)).toEqual([`${linkKey(dup1)}#1`, linkKey(dup1)]);
  });
});

describe("要約タイル (#2215)", () => {
  it("最大遅延・WAL 保持量の合計・非アクティブなスロット数を数える", () => {
    const sum = summarizeReplication(
      [link({ lag_secs: 3 }), link({ lag_secs: 45 }), link({ lag_secs: null })],
      [
        slot({ name: "a", active: true, retained_bytes: 100 }),
        slot({ name: "b", active: false, retained_bytes: 50 }),
        slot({ name: "c", active: false, retained_bytes: null }),
      ],
    );
    expect(sum).toEqual({
      maxLagSecs: 45,
      retainedBytesTotal: 150,
      inactiveSlots: 2,
      attentionLinks: 1,
    });
  });

  it("値が無ければ null (0 と区別する)。非有限値は無視する", () => {
    expect(summarizeReplication([], [])).toEqual({
      maxLagSecs: null,
      retainedBytesTotal: null,
      inactiveSlots: 0,
      attentionLinks: 0,
    });
    expect(summarizeReplication([link({ lag_secs: Number.NaN })], []).maxLagSecs).toBeNull();
    expect(summarizeReplication([link({ lag_secs: 0 })], []).maxLagSecs).toBe(0);
    expect(summarizeReplication([], [slot({ retained_bytes: 0 })]).retainedBytesTotal).toBe(0);
  });
});

describe("推移 (#2215)", () => {
  it("pushSample は直近 max 点だけ残し、非有限値は欠測 (null) にする", () => {
    expect(pushSample([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(pushSample([], Number.NaN)).toEqual([null]);
    expect(pushSample([1], null, 5)).toEqual([1, null]);
  });

  it("sampleDelta は末尾 2 点の差。欠測・2 点未満は null", () => {
    expect(sampleDelta([1, 4])).toBe(3);
    expect(sampleDelta([5, 2])).toBe(-3);
    expect(sampleDelta([1])).toBeNull();
    expect(sampleDelta(undefined)).toBeNull();
    expect(sampleDelta([1, null])).toBeNull();
    expect(sampleDelta([null, 1])).toBeNull();
  });

  it("appendReplicationHistory は要約・接続先ごとに積み、消えた接続先は捨てる", () => {
    const a = keyLinks([link({ name: "a", lag_secs: 1 }), link({ name: "b", lag_secs: 2 })]);
    const h1 = appendReplicationHistory(EMPTY_REPLICATION_HISTORY, a, [slot({ retained_bytes: 10 })]);
    expect(h1.maxLag).toEqual([2]);
    expect(h1.retainedTotal).toEqual([10]);
    expect(h1.linkLag[a[0].key]).toEqual([1]);
    const b = keyLinks([link({ name: "a", lag_secs: 5 }), link({ name: "c", lag_secs: 9 })]);
    const h2 = appendReplicationHistory(h1, b, [slot({ retained_bytes: 30 })]);
    expect(h2.maxLag).toEqual([2, 9]);
    expect(h2.retainedTotal).toEqual([10, 30]);
    expect(h2.linkLag[b[0].key]).toEqual([1, 5]);
    expect(h2.linkLag[b[1].key]).toEqual([9]);
    expect(Object.keys(h2.linkLag)).toHaveLength(2);
  });

  it("入力の履歴を書き換えない / 上限を守る", () => {
    const l = keyLinks([link({ lag_secs: 1 })]);
    let h = EMPTY_REPLICATION_HISTORY;
    for (let i = 0; i < 5; i++) h = appendReplicationHistory(h, l, [], 3);
    expect(h.maxLag).toHaveLength(3);
    expect(EMPTY_REPLICATION_HISTORY.maxLag).toEqual([]);
  });
});

describe("トポロジー図の配置 (#2215)", () => {
  it("遅延の段階の境界 (5 秒 / 30 秒) と太さ", () => {
    expect(topologyLagLevel(null)).toBe("unknown");
    expect(topologyLagLevel(-1)).toBe("unknown");
    expect(topologyLagLevel(0)).toBe("ok");
    expect(topologyLagLevel(4.9)).toBe("ok");
    expect(topologyLagLevel(5)).toBe("slow");
    expect(topologyLagLevel(LAG_WARN_SECS - 0.1)).toBe("slow");
    expect(topologyLagLevel(LAG_WARN_SECS)).toBe("warn");
    expect(edgeThickness("unknown")).toBe(1);
    expect(edgeThickness("ok")).toBe(1);
    expect(edgeThickness("slow")).toBe(2);
    expect(edgeThickness("warn")).toBe(3);
  });

  it("上流・下流に振り分け、異常のあるノードを先頭にする", () => {
    const layout = layoutTopology(
      keyLinks([
        link({ name: "b", lag_secs: 1 }),
        link({ name: "z", lag_secs: 40 }),
        link({ name: "up", direction: "upstream", lag_secs: 2, io_running: false }),
      ]),
    );
    expect(layout.downstream.map((p) => p.name)).toEqual(["z", "b"]);
    expect(layout.downstream[0]).toMatchObject({ level: "warn", thickness: 3, attention: true });
    expect(layout.downstream[1]).toMatchObject({ level: "ok", attention: false });
    expect(layout.upstream.map((p) => p.name)).toEqual(["up"]);
    expect(layout.upstream[0].attention).toBe(true);
  });

  it("接続先が無ければ両側とも空。上限を超えた分は件数にまとめる", () => {
    expect(layoutTopology([])).toEqual({ upstream: [], downstream: [], upstreamMore: 0, downstreamMore: 0 });
    const many = keyLinks(
      Array.from({ length: TOPOLOGY_MAX_PER_SIDE + 3 }, (_, i) => link({ name: `r${i}` })),
    );
    const layout = layoutTopology(many);
    expect(layout.downstream).toHaveLength(TOPOLOGY_MAX_PER_SIDE);
    expect(layout.downstreamMore).toBe(3);
    // 重複する接続先の key は一意のまま保たれる。
    const dup = layoutTopology(keyLinks([link({ name: "w" }), link({ name: "w" })]));
    expect(new Set(dup.downstream.map((p) => p.key)).size).toBe(2);
  });
});

describe("トポロジー図の負の遅延 (#2215)", () => {
  it("負の遅延は段階も lagSecs も報告なしに揃える", () => {
    const p = layoutTopology(keyLinks([link({ lag_secs: -3 })])).downstream[0];
    expect(p).toMatchObject({ level: "unknown", lagSecs: null });
  });
});
