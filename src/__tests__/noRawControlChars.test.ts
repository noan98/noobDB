import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// ソースに生の制御文字 (NUL や 0x1F など) が混ざると、git が「バイナリ」と判定して
// PR 画面で差分が出なくなり (#2253 の pivotData.ts)、ripgrep も既定で結果から黙って
// 落とす (#2272)。文字列に制御文字が要るときは `\u0000` / `\u001F` のエスケープで書く
// (値は同じ)。タブ・LF・CR は正当な空白なので許可する。
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

const ROOT = join(__dirname, "..", "..");
const TARGETS: { dir: string; ext: RegExp }[] = [
  { dir: "src", ext: /\.(ts|tsx)$/ },
  { dir: "src-tauri/src", ext: /\.rs$/ },
  { dir: ".github", ext: /\.ya?ml$/ },
];

function walk(dir: string, ext: RegExp, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__screenshots__") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (ext.test(name)) out.push(full);
  }
}

describe("no raw control characters in source (#2272)", () => {
  it("検出パターンは NUL / 0x1F を拾い、タブ・LF・CR は拾わない", () => {
    expect(FORBIDDEN.test(String.fromCharCode(0))).toBe(true);
    expect(FORBIDDEN.test(String.fromCharCode(0x1f))).toBe(true);
    expect(FORBIDDEN.test("a\tb\r\n")).toBe(false);
  });

  it("src / src-tauri/src / .github のソースに生の制御文字が無い", () => {
    const offenders: string[] = [];
    for (const { dir, ext } of TARGETS) {
      const files: string[] = [];
      walk(join(ROOT, dir), ext, files);
      for (const f of files) {
        const lines = readFileSync(f, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (FORBIDDEN.test(line)) offenders.push(`${relative(ROOT, f)}:${i + 1}`);
        });
      }
    }
    expect(offenders, "\\u0000 のようなエスケープ表記に置き換える").toEqual([]);
  });
});
