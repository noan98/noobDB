import { describe, expect, it } from "vitest";
// `ipcArgParity.test.ts` と同じ `import.meta.glob` 方式 (#970)。
//
// かつては「イベントを emit する Rust ファイルは query.rs / dump.rs / export.rs /
// import.rs / connection.rs / tasks/scheduler.rs の 6 つに限られる (grep で確認済み)」
// という前提でこの 6 ファイルだけを個別に `?raw` import していた。しかし
// `ipcArgParity.test.ts` が #921 で踏んだのと同じ罠で、この前提は将来の変更で
// 静かに陳腐化しうる — 例えば `commands/sandbox.rs` (サンドボックスコピーの
// 長時間処理) や `commands/flight_recorder.rs` (レコーダ進捗) が新たに `.emit()`
// を追加しても、ハードコードされた import リストへの追記を忘れる限りパリティ
// 検査は永遠にそれを見ない。`src-tauri/src/**/*.rs` を再帰的に列挙することで、
// ファイル追加時の追記漏れ自体を構造的に無くす (`commands/*.rs` に限定せず全体を
// 対象にするのは、将来 `ssh/` や `flight_recorder/` など commands 外のモジュールが
// 直接 emit するようになっても取りこぼさないため)。
import tauriTs from "../api/tauri.ts?raw";

const rustModules = import.meta.glob("../../src-tauri/src/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;
const rustSources = Object.values(rustModules);

// ストリーミングイベント名のフロント (`tauri.ts` の `listen(...)`) ↔ バック
// (`src-tauri/src/**/*.rs` の emit 箇所) パリティ検証 (#797)。
//
// バックエンドのイベント名は emit している各 `.rs` ファイルに文字列リテラルとして
// 散在し、フロントも `src/api/tauri.ts` の `listen("query-stream:columns", …)` 等で
// 別途ハードコードしている。両者はコンパイラが対応関係を検証してくれないため、名前の
// タイポや片側だけの追加・削除漏れは実行時まで気付けない。ここでは両ソースから
// イベント名の集合を機械的に抽出して突き合わせ、片側にしか存在しない名前があれば
// テストを落とす。

// `.rs` ファイルの `const EV_XXX: &str = "event-name";` からイベント名リテラルを
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

const emitted = extractEmittedEvents(rustSources);
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
    const offenders = extractEmitFirstArgs(rustSources).filter((arg) => {
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
