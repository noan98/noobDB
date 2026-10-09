import { describe, expect, it } from "vitest";
import libRs from "../../src-tauri/src/lib.rs?raw";
import tauriTs from "../api/tauri.ts?raw";

// IPC ラッパーの置き場所の検査。
//
// ラッパー本体は `src/api/commands/<module>.ts` に置き、`src-tauri/src/commands/<module>.rs`
// と 1 対 1 で対応させる (`tauri.ts` は束ねるだけ)。巨大な 1 オブジェクトに全員が追記すると
// 並列ブランチが同じ位置に挿入して衝突するため、機能ごとに別ファイルへ分けた。
// 置き場所がずれると分けた意味が薄れるので、ここで機械的に揃える。
const commandFiles = import.meta.glob("../api/commands/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** `generate_handler!` の `commands::<module>::<name>` から コマンド名 → モジュール名。 */
function registeredModules(src: string): Map<string, string> {
  const start = src.indexOf("generate_handler![");
  const block = src.slice(start, src.indexOf("]", start));
  const map = new Map<string, string>();
  for (const m of block.matchAll(/commands::(\w+)::(\w+)/g)) map.set(m[2], m[1]);
  return map;
}

function invokedCommands(src: string): string[] {
  return [...src.matchAll(/\binvoke\s*(?:<[^(]*>)?\s*\(\s*"([a-z_][a-z0-9_]*)"/g)].map((m) => m[1]);
}

/** `bulkWrite.ts` → `bulk_write` */
function moduleOf(path: string): string {
  const base = path.replace(/^.*\//, "").replace(/\.ts$/, "");
  return base.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

const modules = registeredModules(libRs);

describe("IPC ラッパーの置き場所 (api/commands/<module>.ts ↔ commands/<module>.rs)", () => {
  it("tauri.ts 自身は invoke を直接呼ばない (ラッパーは api/commands/ に置く)", () => {
    expect(invokedCommands(tauriTs)).toEqual([]);
  });

  it("各ファイルは対応する Rust モジュールのコマンドだけを呼ぶ", () => {
    const misplaced: string[] = [];
    for (const [path, src] of Object.entries(commandFiles)) {
      const expected = moduleOf(path);
      for (const cmd of invokedCommands(src)) {
        const actual = modules.get(cmd);
        if (actual !== expected) {
          misplaced.push(`${path}: ${cmd} は commands::${actual ?? "(未登録)"} のコマンド`);
        }
      }
    }
    expect(misplaced).toEqual([]);
  });

  it("各ファイルの export は tauri.ts の api に束ねられている", () => {
    const missing: string[] = [];
    for (const [path, src] of Object.entries(commandFiles)) {
      for (const m of src.matchAll(/^export const (\w+Commands) = \{/gm)) {
        if (!new RegExp(`^\\s*\\.\\.\\.${m[1]},`, "m").test(tauriTs)) {
          missing.push(`${path}: ${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
