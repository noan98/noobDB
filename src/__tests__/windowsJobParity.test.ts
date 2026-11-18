import { describe, expect, it } from "vitest";

// Windows ビルドジョブ間の共通ステップを固定するメタテスト (#2413)。
//
// `ci.yml` の rust (windows)・`windows-db-smoke.yml`・`release.yml` の build は、いずれも
// Windows ランナーで cargo を回す。Defender のリアルタイム保護の停止 (checkout 前) と、
// release.yml の registry index の offline 化 (ci.yml と同じ probe) が片方から抜けると、
// 緑のまま遅くなるので、ここで検出する。命名規約 `*Parity.test.ts` により crosslang parity で走る。

const workflows = import.meta.glob("../../.github/workflows/*.yml", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const read = (name: string): string => {
  const hit = Object.entries(workflows).find(([p]) => p.endsWith(`/${name}`));
  if (!hit) throw new Error(`${name} が見つからない`);
  return hit[1];
};

const DEFENDER = "Set-MpPreference -DisableRealtimeMonitoring $true";

describe("Windows ジョブの共通ステップ (#2413)", () => {
  for (const name of ["ci.yml", "windows-db-smoke.yml", "release.yml"]) {
    it(`${name}: Defender 停止が最初の checkout より前にある`, () => {
      const src = read(name);
      const d = src.indexOf(DEFENDER);
      expect(d).toBeGreaterThan(-1);
      // Defender 停止より後ろに checkout がある (= 停止してから checkout する) ことを確認する。
      expect(src.indexOf("uses: actions/checkout@", d)).toBeGreaterThan(d);
    });
  }

  it("release.yml: Defender 停止はジョブ先頭 (build の最初の checkout より前)", () => {
    const src = read("release.yml");
    const build = src.indexOf("\n  build:");
    expect(src.indexOf(DEFENDER, build)).toBeGreaterThan(build);
    expect(src.indexOf(DEFENDER, build)).toBeLessThan(src.indexOf("actions/checkout@", build));
  });

  it("release.yml: registry index のキャッシュと offline probe を持つ", () => {
    const src = read("release.yml");
    expect(src).toContain("actions/cache/restore@");
    expect(src).toContain("~/.cargo/registry/index");
    expect(src).toContain("cargo fetch --locked --offline --target x86_64-pc-windows-msvc");
    expect(src).toContain('echo "CARGO_NET_OFFLINE=true" >> "$GITHUB_ENV"');
  });

  it("release.yml: index の保存は main push のみ", () => {
    const src = read("release.yml");
    expect(src).toMatch(
      /Save cargo registry index \(main only\)\n\s+if: [^\n]*github\.ref == 'refs\/heads\/main'/,
    );
  });

  it("release.yml: 所要時間を Job Summary に出す", () => {
    expect(read("release.yml")).toContain("Job timing & cache summary (#565)");
  });
});
