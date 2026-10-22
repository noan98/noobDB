import { describe, expect, it } from "vitest";
import type { ConnectionProfile } from "../api/tauri";
import {
  activeIndexForPhase,
  buildConnectionPath,
  edgeLitAt,
  hostPortLabel,
  nodeStateAt,
  pathInputFromProfile,
  truncateMiddle,
} from "../components/connectionPath";

const kinds = (p: ReturnType<typeof buildConnectionPath>) => p.nodes.map((n) => n.kind);

describe("buildConnectionPath", () => {
  it("直接: ローカル → 目標、線は plain", () => {
    const p = buildConnectionPath({ route: "direct", host: "db.example", port: "3306" });
    expect(kinds(p)).toEqual(["local", "target"]);
    expect(p.edges).toEqual(["plain"]);
    expect(p.nodes[1].label).toBe("db.example:3306");
    expect(p.nodes[1].fullLabel).toBe("db.example:3306");
  });

  it("SSH: ローカル → 踏み台 → 目標、線は tunnel", () => {
    const p = buildConnectionPath({
      route: "ssh",
      host: "10.0.0.5",
      port: 5432,
      ssh: { host: "bastion", port: "22" },
    });
    expect(kinds(p)).toEqual(["local", "bastion", "target"]);
    expect(p.edges).toEqual(["tunnel", "tunnel"]);
    expect(p.nodes[1].label).toBe("bastion:22");
  });

  it("多段 jump: jump が踏み台の前に入る", () => {
    const p = buildConnectionPath({
      route: "ssh",
      host: "db",
      port: 3306,
      ssh: { host: "inner", port: 22, jump: { host: "outer", port: 2222 } },
    });
    expect(kinds(p)).toEqual(["local", "jump", "bastion", "target"]);
    expect(p.nodes[1].label).toBe("outer:2222");
    expect(p.edges).toHaveLength(3);
  });

  it("SSM: ローカル → SSM → 目標", () => {
    const p = buildConnectionPath({
      route: "ssm",
      host: "rds.example",
      port: 5432,
      ssm: { target: "i-0123456789abcdef0" },
    });
    expect(kinds(p)).toEqual(["local", "ssm", "target"]);
    expect(p.nodes[1].label).toBe("i-0123456789abcdef0");
  });

  it("入力途中の空欄は label null (未入力)、ポート未入力 / 非数値はホストのみ", () => {
    const p = buildConnectionPath({ route: "ssh", host: "", port: "", ssh: { host: " ", port: "" } });
    expect(p.nodes.map((n) => n.label)).toEqual([null, null, null]);
    expect(hostPortLabel("h", "")).toBe("h");
    expect(hostPortLabel("h", "abc")).toBe("h");
    expect(hostPortLabel("h", "0")).toBe("h");
  });

  it("route が ssh / ssm でも設定が無ければ直接として描く", () => {
    expect(kinds(buildConnectionPath({ route: "ssh", host: "h", port: 1 }))).toEqual(["local", "target"]);
    expect(buildConnectionPath({ route: "ssm", host: "h", port: 1, ssm: null }).edges).toEqual(["plain"]);
  });
});

describe("truncateMiddle", () => {
  it("上限以内はそのまま、超えたら中略して上限長に収める", () => {
    expect(truncateMiddle("abc", 24)).toBe("abc");
    const out = truncateMiddle("a".repeat(10) + "b".repeat(30), 24);
    expect(Array.from(out)).toHaveLength(24);
    expect(out).toContain("…");
    expect(out.startsWith("a")).toBe(true);
    expect(out.endsWith("b")).toBe(true);
  });

  it("中略しても fullLabel は全文のまま", () => {
    const host = `${"h".repeat(40)}.example.com`;
    const p = buildConnectionPath({ route: "direct", host, port: 5432 });
    expect(p.nodes[1].label).not.toBe(`${host}:5432`);
    expect(p.nodes[1].fullLabel).toBe(`${host}:5432`);
  });

  it("サロゲートペアを壊さない", () => {
    const out = truncateMiddle("🚀".repeat(40), 10);
    expect(Array.from(out)).toHaveLength(10);
  });
});

describe("接続フェーズの点灯", () => {
  it("activeIndexForPhase: 各フェーズの進行中ノード", () => {
    // ローカル → jump → 踏み台 → 目標 (4 ノード)
    expect(activeIndexForPhase(4, "preparing")).toBe(0);
    expect(activeIndexForPhase(4, "tunnel_connecting")).toBe(1);
    expect(activeIndexForPhase(4, "tunnel_authenticating")).toBe(2);
    expect(activeIndexForPhase(4, "db_connecting")).toBe(3);
    expect(activeIndexForPhase(4, "unknown")).toBe(0);
    expect(activeIndexForPhase(4, "connected")).toBeNull();
  });

  it("単一ホップ / 直接でも範囲外に出ない", () => {
    expect(activeIndexForPhase(3, "tunnel_authenticating")).toBe(1);
    expect(activeIndexForPhase(2, "tunnel_connecting")).toBe(1);
    expect(activeIndexForPhase(2, "tunnel_authenticating")).toBe(1);
    expect(activeIndexForPhase(1, "db_connecting")).toBe(0);
  });

  it("nodeStateAt / edgeLitAt: 左から順に done → active → pending", () => {
    expect([0, 1, 2].map((i) => nodeStateAt(i, 1))).toEqual(["done", "active", "pending"]);
    expect([0, 1].map((i) => edgeLitAt(i, 1))).toEqual([true, false]);
  });

  it("active が null (確立済み / 静的) なら全点灯", () => {
    expect([0, 1, 2].map((i) => nodeStateAt(i, null))).toEqual(["done", "done", "done"]);
    expect(edgeLitAt(5, null)).toBe(true);
  });
});

describe("pathInputFromProfile", () => {
  const base = {
    id: "p",
    name: "n",
    driver: "postgres",
    host: "db",
    port: 5432,
    user: "u",
    database: null,
    ssh: null,
    ssm: null,
    file_path: null,
  } as unknown as ConnectionProfile;

  it("ssh > ssm > 直接の優先で route を決める", () => {
    expect(pathInputFromProfile(base)?.route).toBe("direct");
    const ssm = { ...base, ssm: { target: "i-1", region: "" } } as ConnectionProfile;
    expect(pathInputFromProfile(ssm)?.route).toBe("ssm");
    const ssh = {
      ...ssm,
      ssh: {
        host: "b",
        port: 22,
        user: "x",
        auth_method: "key",
        private_key_path: "/secret/key",
        jump: null,
      },
    } as ConnectionProfile;
    const input = pathInputFromProfile(ssh);
    expect(input?.route).toBe("ssh");
    // 鍵パス・ユーザは図の入力に含めない
    expect(JSON.stringify(input)).not.toContain("secret");
  });

  it("SQLite (ファイル) は経路図を出さない", () => {
    expect(pathInputFromProfile({ ...base, driver: "sqlite", file_path: "/a.db" })).toBeNull();
  });
});
