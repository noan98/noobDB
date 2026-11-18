import { describe, expect, it } from "vitest";
import ciYml from "../../.github/workflows/ci.yml?raw";
import releaseYml from "../../.github/workflows/release.yml?raw";
import smokeYml from "../../.github/workflows/windows-db-smoke.yml?raw";

// Windows ビルドジョブ間の共通ステップを固定するメタテスト (#2413)。
//
// `ci.yml` の rust (windows)・`windows-db-smoke.yml`・`release.yml` の build は、いずれも
// Windows ランナーで cargo を回す。Defender のリアルタイム保護の停止 (checkout 前) と、
// release.yml の registry index の offline 化 (ci.yml と同じ probe) が片方から抜けると、
// 緑のまま遅くなるので、ここで検出する。命名規約 `*Parity.test.ts` により crosslang parity で走る。

const DEFENDER = "Set-MpPreference -DisableRealtimeMonitoring $true";

const sources: Record<string, string> = {
  "ci.yml": ciYml,
  "windows-db-smoke.yml": smokeYml,
  "release.yml": releaseYml,
};
const read = (name: string): string => sources[name] ?? "";

// Defender 停止ステップを含むジョブのブロック (ジョブ見出し行から次のジョブ見出し行まで) を返す。
function defenderJob(src: string): string {
  const d = src.indexOf(DEFENDER);
  if (d < 0) return "";
  const heads = [...src.matchAll(/\n {2}[\w-]+:\n/g)].map((m) => m.index ?? 0);
  const start = Math.max(...heads.filter((i) => i < d), 0);
  const end = heads.find((i) => i > d) ?? src.length;
  return src.slice(start, end);
}

describe("Windows ジョブの共通ステップ (#2413)", () => {
  for (const name of ["ci.yml", "windows-db-smoke.yml", "release.yml"]) {
    it(`${name}: Defender 停止が同じジョブの最初の checkout より前にある`, () => {
      const job = defenderJob(read(name));
      const d = job.indexOf(DEFENDER);
      const co = job.indexOf("uses: actions/checkout@");
      expect(d).toBeGreaterThan(-1);
      expect(co).toBeGreaterThan(-1);
      expect(d).toBeLessThan(co);
    });
  }

  it("release.yml: registry index のキャッシュと offline probe を持つ", () => {
    const src = read("release.yml");
    expect(src).toContain("actions/cache/restore@");
    expect(src).toContain("~/.cargo/registry/index");
    expect(src).toContain("cargo fetch --locked --offline --target x86_64-pc-windows-msvc");
    expect(src).toContain('echo "CARGO_NET_OFFLINE=true" >> "$GITHUB_ENV"');
  });

  it("release.yml: index の保存は main ref のみ", () => {
    const src = read("release.yml");
    expect(src).toMatch(
      /Save cargo registry index \(main only\)\n\s+if: [^\n]*github\.ref == 'refs\/heads\/main'/,
    );
  });

  it("release.yml: 所要時間を Job Summary に出す", () => {
    expect(read("release.yml")).toContain("Job timing & cache summary (#565)");
  });
});
