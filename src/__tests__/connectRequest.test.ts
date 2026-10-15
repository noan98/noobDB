import { describe, expect, it } from "vitest";
import type { ConnectionProfile } from "../api/tauri";
import { connectRequestFromProfile, normalizeDriver } from "../connectRequest";

const profile: ConnectionProfile = {
  id: "p1",
  name: "Prod",
  driver: "postgres",
  host: "db.example.com",
  port: 5432,
  user: "app",
  database: "appdb",
  ssh: {
    host: "bastion",
    port: 22,
    user: "ops",
    auth_method: "key",
    private_key_path: "/k",
    jump: { host: "j", port: 22, user: "jo", auth_method: "agent", private_key_path: "" },
  },
  group: null,
  color: null,
  is_production: false,
  confirm_writes: false,
  read_only: true,
  skip_history: false,
  file_path: null,
  ssl_mode: "verify_ca",
  ssl_root_cert: "/ca.pem",
  ssl_client_cert: "/c.pem",
  ssl_client_key: "/c.key",
  init_sql: "SET search_path = app;",
  aws_iam: { region: "ap-northeast-1", profile: "work" },
  ssm: { target: "i-0123456789abcdef0", region: "", profile: "work" },
};

describe("connectRequestFromProfile", () => {
  it("写すべき非秘密フィールドをすべて写す", () => {
    const req = connectRequestFromProfile({ ...profile, ssh: null });
    expect(req).toEqual({
      profile_id: "p1",
      driver: "postgres",
      host: "db.example.com",
      port: 5432,
      user: "app",
      password: "",
      database: "appdb",
      ssh: null,
      file_path: null,
      ssl_mode: "verify_ca",
      ssl_root_cert: "/ca.pem",
      ssl_client_cert: "/c.pem",
      ssl_client_key: "/c.key",
      init_sql: "SET search_path = app;",
      aws_iam: { region: "ap-northeast-1", profile: "work" },
      ssm: { target: "i-0123456789abcdef0", region: "", profile: "work" },
      read_only: true,
      skip_history: false,
    });
  });

  it("SSH の秘密は空にして踏み台も写す", () => {
    const req = connectRequestFromProfile(profile);
    expect(req.ssh).toMatchObject({ host: "bastion", passphrase: "", password: "" });
    expect(req.ssh?.jump).toMatchObject({ host: "j", passphrase: "", password: "" });
  });

  it("overrides が read_only / skip_history を上書きする", () => {
    const req = connectRequestFromProfile(profile, { read_only: false, skip_history: true });
    expect(req.read_only).toBe(false);
    expect(req.skip_history).toBe(true);
  });

  it("未設定の項目は null になる", () => {
    const bare = { ...profile, ssh: null } as ConnectionProfile;
    for (const k of ["ssl_mode", "ssl_root_cert", "init_sql", "aws_iam", "ssm"] as const) {
      delete bare[k];
    }
    const req = connectRequestFromProfile(bare);
    expect(req.ssl_mode).toBeNull();
    expect(req.init_sql).toBeNull();
    expect(req.aws_iam).toBeNull();
    expect(req.ssm).toBeNull();
  });

  it("未知のドライバは mysql に正規化する", () => {
    expect(normalizeDriver("oracle")).toBe("mysql");
    expect(normalizeDriver("sqlite")).toBe("sqlite");
  });
});
