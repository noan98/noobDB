import { describe, it, expect } from "vitest";
import golden from "./fixtures/awsIamGolden.json";
import type { SslMode } from "../api/tauri";
import {
  buildAwsIamConfig,
  effectiveSslModeForIam,
  inferRdsRegion,
  isIamCapableDriver,
  isSslModeAllowedForIam,
} from "../components/awsIam";

// AWS RDS IAM 認証 (#734) のフロント側判定。リージョン推定と TLS 強制は Rust
// (`src-tauri/src/db/aws_iam.rs`) と共有ゴールデンで同じ結果になることを固定する。
describe("awsIam shared golden (#734)", () => {
  it.each(golden.regionFromHost)("infers the region of $host", ({ host, region }) => {
    expect(inferRdsRegion(host)).toBe(region);
  });

  it.each(golden.enforceTls)("forces TLS for IAM: $mode -> $effective", ({ mode, effective }) => {
    expect(effectiveSslModeForIam(mode as SslMode | null)).toBe(effective);
  });
});

describe("awsIam form helpers (#734)", () => {
  it("offers IAM only for MySQL / PostgreSQL", () => {
    expect(isIamCapableDriver("mysql")).toBe(true);
    expect(isIamCapableDriver("postgres")).toBe(true);
    expect(isIamCapableDriver("mssql")).toBe(false);
    expect(isIamCapableDriver("sqlite")).toBe(false);
    expect(isIamCapableDriver("duckdb")).toBe(false);
  });

  it("disallows the plaintext-capable TLS modes", () => {
    expect(isSslModeAllowedForIam("disable")).toBe(false);
    expect(isSslModeAllowedForIam("prefer")).toBe(false);
    expect(isSslModeAllowedForIam("require")).toBe(true);
    expect(isSslModeAllowedForIam("verify_ca")).toBe(true);
    expect(isSslModeAllowedForIam("verify_full")).toBe(true);
  });

  it("builds the request payload only when IAM is selected on a capable driver", () => {
    expect(buildAwsIamConfig("password", "mysql", "us-east-1", "work")).toBeNull();
    expect(buildAwsIamConfig("aws_iam", "mssql", "us-east-1", "work")).toBeNull();
    expect(buildAwsIamConfig("aws_iam", "postgres", " us-east-1 ", "  ")).toEqual({
      region: "us-east-1",
      profile: null,
    });
    expect(buildAwsIamConfig("aws_iam", "mysql", "", " work ")).toEqual({
      region: "",
      profile: "work",
    });
  });
});
