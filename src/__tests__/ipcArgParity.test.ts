import { describe, expect, it } from "vitest";
// `ipcCommandParity.test.ts` と同じ `?raw` インポートパターン。バックエンドの
// コマンド実装は `src-tauri/src/commands/*.rs` に散らばっているため、全ファイルを
// 個別に取り込む。
import advisorRs from "../../src-tauri/src/commands/advisor.rs?raw";
import connectionRs from "../../src-tauri/src/commands/connection.rs?raw";
import diffRs from "../../src-tauri/src/commands/diff.rs?raw";
import dumpRs from "../../src-tauri/src/commands/dump.rs?raw";
import exportRs from "../../src-tauri/src/commands/export.rs?raw";
import fileRs from "../../src-tauri/src/commands/file.rs?raw";
import historyRs from "../../src-tauri/src/commands/history.rs?raw";
import importRs from "../../src-tauri/src/commands/import.rs?raw";
import inspectorRs from "../../src-tauri/src/commands/inspector.rs?raw";
import logsRs from "../../src-tauri/src/commands/logs.rs?raw";
import processRs from "../../src-tauri/src/commands/process.rs?raw";
import profilesRs from "../../src-tauri/src/commands/profiles.rs?raw";
import queryRs from "../../src-tauri/src/commands/query.rs?raw";
import schemaRs from "../../src-tauri/src/commands/schema.rs?raw";
import serverRs from "../../src-tauri/src/commands/server.rs?raw";
import snippetsRs from "../../src-tauri/src/commands/snippets.rs?raw";
import sshRs from "../../src-tauri/src/commands/ssh.rs?raw";
import syncRs from "../../src-tauri/src/commands/sync.rs?raw";
import tauriTs from "../api/tauri.ts?raw";

// IPC コマンドの「引数名」ドリフト検出 (#825)。
//
// `ipcCommandParity.test.ts` はコマンド名 (文字列) の登録漏れ/呼び出し漏れしか
// 見ない。しかし `tauri.ts` は `invoke("cancel_connect", { attemptId })` のように
// camelCase キーを持つオブジェクトを渡し、Tauri がそれを snake_case へ変換して
// Rust 側の `#[tauri::command] fn name(param: T, …)` のパラメータ名にバインドする。
// このバインドは名前ベースなので、
//   - Rust 側だけパラメータ名をリネームする
//   - tauri.ts 側だけキー名をリネームする
//   - どちらかで引数を追加/削除し忘れる
// といった変更はコンパイルを通過し、実行時に該当引数へ `null`/`undefined` が渡る
// 無音の破損になる (コマンド名自体は変わらないので既存テストはすり抜ける)。
//
// ここでは両ソースから「コマンド名 → 引数名の集合」を機械的に抽出し、
// `State` / `AppHandle` / `Window` など Tauri が注入する引数を除外したうえで
// 集合同士を突き合わせる。

/** 全角/半角問わずクォート文字。文字列リテラル内の `,` `:` `(` などを無視するために使う。 */
function isQuoteChar(ch: string): boolean {
  return ch === '"' || ch === "'" || ch === "`";
}

/**
 * `text` を `delimiter` (1 文字) の**トップレベル**出現位置で分割する。
 * `()` `[]` `{}` のネストと (任意で) 文字列リテラル (エスケープ込み) を認識する
 * ため、`Option<Vec<String>>` のような入れ子や `a ? b : c` のような式の中の
 * 区切り文字を誤って分割点として扱わない。Rust の型 (`<...>`) を扱う呼び出し元は、
 * あらかじめ `<` `>` も深さに含めた文字列を渡すこと。
 *
 * `trackStrings` は既定 `true` (TypeScript の式を想定)。**Rust の型シグネチャを
 * 解析するときは `false` を渡すこと** — ライフタイム `'_` の `'` を文字列開始の
 * シングルクォートと誤認し、残り全体を「文字列の中」とみなして壊れるため。
 */
function splitTopLevel(
  text: string,
  delimiter: string,
  angleDepth = false,
  trackStrings = true,
): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        i++;
        if (i < text.length) current += text[i];
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (trackStrings && isQuoteChar(ch)) {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || (angleDepth && ch === "<")) {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}" || (angleDepth && ch === ">")) {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === delimiter && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * `text[openIdx]` が `([{` のいずれかである前提で、対応する閉じ括弧の index を返す。
 * `trackStrings` の注意点は {@link splitTopLevel} と同じ (Rust 解析では `false`)。
 */
function findMatchingBracketClose(text: string, openIdx: number, trackStrings = true): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (trackStrings && isQuoteChar(ch)) {
      inString = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `text[openIdx] === "<"` の前提で、対応する `>` の index を返す (文字列非対応、型のみ)。 */
function findMatchingAngleClose(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<") depth++;
    else if (ch === ">") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * `text` 中で `()` `[]` `{}` のネストと文字列リテラルを避けた**トップレベル**の
 * 最初の `ch` の index を返す (無ければ -1)。オブジェクトプロパティの
 * `key: value` からキー名を取り出す際に使う — 三項演算子 (`cond ? a : b`) の
 * コロンのように、値の中にネストせず現れる二重コロンと区別するため。
 */
function firstTopLevelIndexOf(text: string, ch: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (isQuoteChar(c)) {
      inString = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/** `snake_case` → `camelCase` (Tauri が invoke キーを Rust 引数名へ変換するのと同じ規則)。 */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Tauri が自動注入する特殊な引数の型かどうか。これらはフロントから渡されない
 * (invoke の引数オブジェクトに現れない) ので、パラメータ名パリティの対象から除外する。
 */
function isInjectedArgType(rustType: string): boolean {
  const head = rustType.trim().split(/[<\s]/)[0];
  return head === "State" || head === "AppHandle" || head === "Window" || head === "WebviewWindow";
}

/**
 * 1 つの `.rs` ソースから `#[tauri::command]` 直下の各関数の
 * `コマンド名 → 引数名 (camelCase, 注入型を除く) の配列` を抽出する。
 * `pub(crate) async fn foo_inner(...)` のような委譲先ヘルパー (属性が付かない) は
 * 対象にしない。
 */
function extractRustCommandParams(source: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const attrRe = /#\[tauri::command\]/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRe.exec(source)) !== null) {
    const start = attrMatch.index;
    // 関数本体の開始 `{` まで (パラメータの型に `{` は現れない) を対象にする。
    const braceIdx = source.indexOf("{", start);
    if (braceIdx === -1) continue;
    const chunk = source.slice(start, braceIdx);

    const fnMatch = /\bfn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/.exec(chunk);
    if (!fnMatch) {
      throw new Error(`#[tauri::command] の直後に fn 定義が見つからない: ${chunk.slice(0, 80)}`);
    }
    const name = fnMatch[1];
    const openParenIdx = fnMatch.index + fnMatch[0].length - 1;
    // Rust のライフタイム `'_` の `'` を文字列区切りと誤認しないよう trackStrings=false。
    const closeParenIdx = findMatchingBracketClose(chunk, openParenIdx, false);
    if (closeParenIdx === -1) {
      throw new Error(`${name} の引数リストの閉じ括弧が見つからない`);
    }
    const paramsRaw = chunk.slice(openParenIdx + 1, closeParenIdx);
    // 行コメント (日本語の注釈など) を除去してから分割する。
    const paramsNoComments = paramsRaw.replace(/\/\/[^\n]*/g, "");
    const rawParams = splitTopLevel(paramsNoComments, ",", true, false)
      .map((p) => p.trim())
      .filter((p) => p !== "");

    const paramNames: string[] = [];
    for (const raw of rawParams) {
      const cleaned = raw.replace(/^mut\s+/, "");
      if (cleaned === "self" || cleaned === "&self" || cleaned === "&mut self") continue;
      const colonIdx = cleaned.indexOf(":");
      if (colonIdx === -1) {
        throw new Error(`${name} のパラメータを解析できない: "${raw}"`);
      }
      const paramName = cleaned.slice(0, colonIdx).trim();
      const paramType = cleaned.slice(colonIdx + 1).trim();
      if (isInjectedArgType(paramType)) continue;
      paramNames.push(snakeToCamel(paramName));
    }
    if (result.has(name)) {
      throw new Error(`コマンド名 "${name}" が複数の #[tauri::command] で重複している`);
    }
    result.set(name, paramNames);
  }
  return result;
}

/**
 * `tauri.ts` から `invoke("name", { key1, key2: expr, ... })` 呼び出しごとに
 * `コマンド名 → 引数オブジェクトのトップレベルキー集合` を抽出する。第 2 引数を
 * 省略した呼び出し (`invoke("read_logs")`) は空集合とする。`invoke` の定義行
 * (`function invoke<T>(cmd: string, args?: ...)`) は第 1 引数が文字列リテラルで
 * ないため自然に除外される。
 */
function extractInvokedArgs(tauriTs: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const re = /\binvoke\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tauriTs)) !== null) {
    let i = m.index + m[0].length;
    while (i < tauriTs.length && /\s/.test(tauriTs[i])) i++;
    if (tauriTs[i] === "<") {
      const closeAngle = findMatchingAngleClose(tauriTs, i);
      if (closeAngle === -1) continue;
      i = closeAngle + 1;
      while (i < tauriTs.length && /\s/.test(tauriTs[i])) i++;
    }
    if (tauriTs[i] !== "(") continue;
    const openParenIdx = i;
    const closeParenIdx = findMatchingBracketClose(tauriTs, openParenIdx);
    if (closeParenIdx === -1) continue;
    const interior = tauriTs.slice(openParenIdx + 1, closeParenIdx);
    const rawArgs = splitTopLevel(interior, ",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    if (rawArgs.length === 0) continue;

    const cmdMatch = /^"([a-z_][a-z0-9_]*)"$/.exec(rawArgs[0]);
    if (!cmdMatch) continue; // `invoke` の定義自体など、コマンド呼び出しでないもの
    const cmdName = cmdMatch[1];

    const keys = new Set<string>();
    if (rawArgs.length >= 2) {
      const objText = rawArgs[1];
      if (!(objText.startsWith("{") && objText.endsWith("}"))) {
        throw new Error(
          `invoke("${cmdName}", …) の第 2 引数がオブジェクトリテラルでない (静的解析非対応): ${objText}`,
        );
      }
      const objInterior = objText.slice(1, -1);
      const props = splitTopLevel(objInterior, ",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      for (const prop of props) {
        if (prop.startsWith("...")) {
          throw new Error(`invoke("${cmdName}", …) の引数にスプレッドが使われ静的解析できない: ${prop}`);
        }
        // 先頭の (トップレベルの) ':' がキーと値の区切り。三項演算子の ':' は必ず
        // その後に現れるので、最初の 1 個だけを見れば良い。
        const colonIdx = firstTopLevelIndexOf(prop, ":");
        const key = (colonIdx === -1 ? prop : prop.slice(0, colonIdx)).trim();
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)) {
          throw new Error(`invoke("${cmdName}", …) の引数キーを解析できない: "${prop}"`);
        }
        keys.add(key);
      }
    }
    // 同じコマンドが複数箇所から呼ばれることは無い想定。もしあれば単純に上書きする
    // (キー集合が食い違えばどのみち後段のパリティチェックで検出される)。
    result.set(cmdName, keys);
  }
  return result;
}

/**
 * 正当な理由でフロント/バックの引数キー集合が食い違うケースの許可リスト。
 * 要素を足すときは理由をコメントで明記すること。現時点で正当な差分は無い。
 */
const KNOWN_DIFFERENCES: Record<string, { onlyInBackend?: string[]; onlyInFrontend?: string[] }> = {};

const rustSources = [
  advisorRs,
  connectionRs,
  diffRs,
  dumpRs,
  exportRs,
  fileRs,
  historyRs,
  importRs,
  inspectorRs,
  logsRs,
  processRs,
  profilesRs,
  queryRs,
  schemaRs,
  serverRs,
  snippetsRs,
  sshRs,
  syncRs,
];

const backendParams = new Map<string, string[]>();
for (const src of rustSources) {
  for (const [name, params] of extractRustCommandParams(src)) {
    if (backendParams.has(name)) {
      throw new Error(`コマンド名 "${name}" が複数の .rs ファイルで重複している`);
    }
    backendParams.set(name, params);
  }
}

const frontendArgs = extractInvokedArgs(tauriTs);

describe("IPC 引数名パリティ (Rust コマンドのパラメータ名 ↔ tauri.ts の invoke キー、#825)", () => {
  it("両ソースから十分な数のコマンド引数情報を抽出できている (抽出ロジックの保険)", () => {
    expect(backendParams.size).toBeGreaterThanOrEqual(30);
    expect(frontendArgs.size).toBeGreaterThanOrEqual(30);
  });

  it("抽出ロジック自体の健全性: State/AppHandle が除外され、複数行シグネチャも正しく拾える", () => {
    // `connect` は AppHandle と State<'_, AppState> の両方を受けるが、実引数は
    // req/attemptId/timeoutSecs の 3 つだけのはず。
    expect(backendParams.get("connect")?.slice().sort()).toEqual(
      ["attemptId", "req", "timeoutSecs"].sort(),
    );
    // `run_query_stream` は #[allow(...)] を挟んだ複数行シグネチャで、末尾に State を持つ。
    expect(backendParams.get("run_query_stream")?.slice().sort()).toEqual(
      [
        "sessionId",
        "streamId",
        "sql",
        "database",
        "initialBatch",
        "chunkSize",
        "autoLimit",
        "queryTimeoutSecs",
        "autoRefresh",
        "forceReadOnly",
      ].sort(),
    );
    // `export_query_result` は引数の間にコメント行を挟む。コメント除去が効いているか確認。
    expect(backendParams.get("export_query_result")?.slice().sort()).toEqual(
      ["path", "format", "columns", "rows", "query", "table", "driver", "batchSize"].sort(),
    );
    // 引数を一切取らないコマンドは空配列。
    expect(backendParams.get("read_logs")).toEqual([]);
    expect(backendParams.get("list_profiles")).toEqual([]);
  });

  it("バックエンドとフロントエンドの双方に存在するコマンドの引数キー集合が一致する", () => {
    const shared = [...backendParams.keys()].filter((name) => frontendArgs.has(name));
    // ipcCommandParity.test.ts がコマンド名自体の登録漏れ/呼び出し漏れを検出するので、
    // ここでは「両方に存在するコマンド」の引数キーだけを突き合わせる。
    expect(shared.length).toBeGreaterThanOrEqual(30);

    const mismatches: string[] = [];
    for (const name of shared) {
      const backendSet = new Set(backendParams.get(name));
      const frontendSet = frontendArgs.get(name) ?? new Set<string>();
      const allowed = KNOWN_DIFFERENCES[name];

      const onlyBackend = [...backendSet]
        .filter((k) => !frontendSet.has(k))
        .filter((k) => !allowed?.onlyInBackend?.includes(k));
      const onlyFrontend = [...frontendSet]
        .filter((k) => !backendSet.has(k))
        .filter((k) => !allowed?.onlyInFrontend?.includes(k));

      if (onlyBackend.length > 0 || onlyFrontend.length > 0) {
        mismatches.push(
          `${name}: backend のみ=[${onlyBackend.sort().join(", ")}] frontend のみ=[${onlyFrontend
            .sort()
            .join(", ")}]`,
        );
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});
