import { describe, expect, it } from "vitest";
// `ipcCommandParity.test.ts` と同じ `?raw` インポート方式で両ソースの中身を文字列
// として取り込む (Node の fs に依存しないため、`tsc` の型チェックでも追加の型定義が
// 不要)。ストリーミングイベントを emit する Rust ファイルは
// `src-tauri/src/commands/query.rs` (`query-stream:*`・`preview-stream:*`・各
// `*-cancelled`)・`dump.rs` (`dump-stream:*`)・`export.rs` (`export-stream:*`)・
// `import.rs` (`csv-import:*`)・`connection.rs` (`connect-progress:phase`)・
// `tasks/scheduler.rs` (`task-run:*`。#730) の 6 つに限られる (他の `commands/*.rs`
// にイベント名リテラルが無いことは実装時に grep で確認済み)。
import connectionRs from "../../src-tauri/src/commands/connection.rs?raw";
import dumpRs from "../../src-tauri/src/commands/dump.rs?raw";
import exportRs from "../../src-tauri/src/commands/export.rs?raw";
import importRs from "../../src-tauri/src/commands/import.rs?raw";
import queryRs from "../../src-tauri/src/commands/query.rs?raw";
import schedulerRs from "../../src-tauri/src/tasks/scheduler.rs?raw";
import tauriTs from "../api/tauri.ts?raw";

// ストリーミングイベント名のフロント (`tauri.ts` の `listen(...)`) ↔ バック
// (`commands/*.rs` の emit 箇所) パリティ検証 (#797)。
//
// バックエンドのイベント名は各 `commands/*.rs` に文字列リテラルとして散在し、フロント
// も `src/api/tauri.ts` の `listen("query-stream:columns", …)` 等で別途ハードコードして
// いる。両者はコンパイラが対応関係を検証してくれないため、名前のタイポや片側だけの
// 追加・削除漏れは実行時まで気付けない。ここでは両ソースからイベント名の集合を機械的に
// 抽出して突き合わせ、片側にしか存在しない名前があればテストを落とす。

// `commands/*.rs` の `const EV_XXX: &str = "event-name";` からイベント名リテラルを
// 抽出する。ストリーミングイベントは「意味の分かる定数名 → リテラル」という書き方に
// 統一されているためこれが主経路だが、将来 `.emit("xxx-yyy:zzz", ...)` のように定数を
// 介さず直接リテラルで emit されても取りこぼさないよう、emit 呼び出しの第一引数に
// 現れるイベント名形状のリテラルも合わせて拾う (下の規約テストとの二段構え)。
function extractEmittedEvents(rustSources: string[]): Set<string> {
  const events = new Set<string>();
  const constRe = /const EV_[A-Z0-9_]+\s*:\s*&str\s*=\s*"([^"]+)";/g;
  const emitLiteralRe = /\.emit(?:_to|_all)?\s*\(\s*"([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)"/g;
  for (const src of rustSources) {
    for (const re of [constRe, emitLiteralRe]) {
      let match: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((match = re.exec(src)) !== null) {
        events.add(match[1]);
      }
    }
  }
  return events;
}

// emit 呼び出しの第一引数トークンを抽出する (規約テスト用)。`\s` は改行にも一致する
// ため、`.emit(\n    EV_XXX,` のような複数行呼び出しも拾える。
function extractEmitFirstArgs(rustSources: string[]): string[] {
  const args: string[] = [];
  const re = /\.emit(?:_to|_all)?\s*\(\s*("[^"]*"|[A-Za-z_][A-Za-z0-9_]*)/g;
  for (const src of rustSources) {
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(src)) !== null) {
      args.push(match[1]);
    }
  }
  return args;
}

// `src/api/tauri.ts` の `listen<...>("event-name", ...)` (ジェネリック省略可) から
// 購読しているイベント名を抽出する。イベント名は `xxx-yyy:zzz-www` 形式 (ハイフン区切り
// の名前空間 + コロン + ハイフン区切りの種別) で統一されている。
function extractListenedEvents(tauriTs: string): Set<string> {
  const events = new Set<string>();
  const re = /\blisten\s*(?:<[^(]*>)?\s*\(\s*"([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tauriTs)) !== null) {
    events.add(match[1]);
  }
  return events;
}

const emitted = extractEmittedEvents([
  queryRs,
  dumpRs,
  exportRs,
  importRs,
  connectionRs,
  schedulerRs,
]);
const listened = extractListenedEvents(tauriTs);

// 片側にのみ正当に存在してよいイベント名の明示的な許可リスト。
// 現状は emit 側・listen 側が完全一致しているため空だが、将来「フロントが購読しない
// emit 専用イベント」等が正当に生まれた場合はここに **理由コメント付きで** 追加すること。
// 黙って除外せず、必ずこの配列と理由コメントを通す。
const EMIT_ONLY_ALLOWLIST: string[] = [];
const LISTEN_ONLY_ALLOWLIST: string[] = [];

describe("ストリーミングイベント名パリティ (Rust emit ↔ tauri.ts listen)", () => {
  it("両ソースから十分な数のイベント名を抽出できている (抽出ロジックの保険)", () => {
    expect(emitted.size).toBeGreaterThanOrEqual(20);
    expect(listened.size).toBeGreaterThanOrEqual(20);
  });

  it("バックエンドが emit しているがフロントが listen していないイベントが無い (許可リスト除く)", () => {
    const missingInFront = [...emitted]
      .filter((name) => !listened.has(name) && !EMIT_ONLY_ALLOWLIST.includes(name))
      .sort();
    expect(
      missingInFront,
      `tauri.ts が listen していない emit イベント: ${missingInFront.join(", ")}`,
    ).toEqual([]);
  });

  it("フロントが listen しているがバックエンドが emit していないイベントが無い (許可リスト除く)", () => {
    const missingInBack = [...listened]
      .filter((name) => !emitted.has(name) && !LISTEN_ONLY_ALLOWLIST.includes(name))
      .sort();
    expect(
      missingInBack,
      `Rust 側に emit の無い listen イベント: ${missingInBack.join(", ")}`,
    ).toEqual([]);
  });

  it("許可リストに載っているイベントが実際に片側にしか存在しない (許可リストの陳腐化防止)", () => {
    for (const name of EMIT_ONLY_ALLOWLIST) {
      expect(emitted.has(name), `${name} は emit 側に存在しない`).toBe(true);
      expect(listened.has(name), `${name} は listen 側にも存在する (許可リストから外すこと)`).toBe(
        false,
      );
    }
    for (const name of LISTEN_ONLY_ALLOWLIST) {
      expect(listened.has(name), `${name} は listen 側に存在しない`).toBe(true);
      expect(emitted.has(name), `${name} は emit 側にも存在する (許可リストから外すこと)`).toBe(
        false,
      );
    }
  });

  it("emit 集合と listen 集合が完全一致する", () => {
    expect([...listened].sort()).toEqual([...emitted].sort());
  });

  it("すべての emit 呼び出しの第一引数が EV_* 定数またはイベント名リテラルである (抽出漏れ防止)", () => {
    // 定数 (EV_*) 経路とリテラル経路の両方は extractEmittedEvents が拾う。それ以外の
    // 形 (別名の定数・変数など) で emit されると抽出から漏れてパリティ検証が素通り
    // するため、ここで規約として固定する。`event` は行バッチ emit ヘルパの転送
    // パラメータ (呼び出し元が EV_* 定数を渡すため、定数経路で抽出済み) の許可。
    // `event_name` も同型: `scheduler.rs::execute_and_log` が成否で
    // `EV_TASK_RUN_DONE` / `EV_TASK_RUN_ERROR` のどちらかを束ねてから emit する
    // ローカル変数で、値自体は EV_* 定数経路で既に抽出済み (#730)。
    const offenders = extractEmitFirstArgs([
      queryRs,
      dumpRs,
      exportRs,
      importRs,
      connectionRs,
      schedulerRs,
    ]).filter((arg) => {
      if (arg.startsWith('"')) return false;
      if (/^EV_[A-Z0-9_]+$/.test(arg)) return false;
      if (arg === "event") return false;
      if (arg === "event_name") return false;
      return true;
    });
    expect(
      offenders,
      `EV_* 定数でもリテラルでもない emit 第一引数: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
