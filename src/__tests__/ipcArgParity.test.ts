import { describe, expect, it } from "vitest";
// `ipcCommandParity.test.ts` と同じ `?raw` インポートパターン。バックエンドの
// コマンド実装は `src-tauri/src/commands/*.rs` に散らばっている。
//
// かつては各ファイルを個別に `import ... from ".../xxx.rs?raw"` で列挙していたが
// (#921)、新しいコマンドモジュールを追加したときにここへの追記を忘れると、その
// モジュールのコマンドは静かに引数パリティ検査から漏れてしまう (実際に advisor 系
// テストのみが動いていた時期に privileges/sandbox/flight_recorder/local/tasks の
// 5 モジュールが漏れていた)。`import.meta.glob` で `commands/*.rs` を機械的に
// 全件取り込むことで、モジュール追加時の追記漏れ自体を構造的に無くす。
import libRs from "../../src-tauri/src/lib.rs?raw";
import tauriTs from "../api/tauri.ts?raw";

const commandModules = import.meta.glob("../../src-tauri/src/commands/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

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
 * `lib.rs` の `generate_handler![...]` ブロックから登録済みコマンド名を抽出する。
 * `ipcCommandParity.test.ts` の同名関数と同じロジック (意図的な複製 — 各テスト
 * ファイルは自己完結させる方針、`splitTopLevel` 等の他ヘルパーも共有していない)。
 * ここでは「lib.rs に登録されているのに `rustSources` (= commands/*.rs の自動
 * 列挙) 側で 1 件も引数を抽出できていないコマンドが無いか」の取りこぼし検知にのみ使う。
 */
function extractRegisteredCommands(source: string): Set<string> {
  const start = source.indexOf("generate_handler![");
  if (start === -1) {
    throw new Error("lib.rs から generate_handler! ブロックが見つからない");
  }
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  if (open === -1 || close === -1) {
    throw new Error("generate_handler! のブラケットが閉じていない");
  }
  const block = source.slice(open + 1, close);

  const commands = new Set<string>();
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (line === "") continue;
    for (const entry of line.split(",")) {
      const trimmed = entry.trim();
      if (trimmed === "") continue;
      const segments = trimmed.split("::");
      const name = segments[segments.length - 1].trim();
      if (name !== "") commands.add(name);
    }
  }
  return commands;
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
 * 行コメント (`//` / `///` / `//!`) の中身を同じ長さの空白に置き換える (改行・
 * 非コメント行はそのまま)。インデックスが元の `source` と完全に一致するので、
 * ここで得た文字列は「コメント中の見た目だけの `#[tauri::command]` 誤検出」を
 * 避けるための走査専用に使い、実際のスライスは常に元の `source` から行う。
 * ドキュメントコメントが「この関数は `#[tauri::command]` の薄いラッパ」のように
 * 属性を**説明文中で言及する**ケース (`query.rs::run_query_inner` 等の委譲先
 * ヘルパー doc) があり、素朴な文字列走査だとその言及自体を属性だと誤認して
 * 直後の `fn` を持たないヘルパーへ迷い込む (最悪 `{` が見つからず例外)。
 */
function stripLineComments(source: string): string {
  return source
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? line.replace(/./g, " ") : line))
    .join("\n");
}

/**
 * 1 つの `.rs` ソースから `#[tauri::command]` 直下の各関数の
 * `コマンド名 → 引数名 (camelCase, 注入型を除く) の配列` を抽出する。
 * `pub(crate) async fn foo_inner(...)` のような委譲先ヘルパー (属性が付かない) は
 * 対象にしない。
 */
function extractRustCommandParams(source: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const scanSource = stripLineComments(source);
  const attrRe = /#\[tauri::command\]/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRe.exec(scanSource)) !== null) {
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

/**
 * `#[tauri::command]` を実装したが `generate_handler!` に登録し忘れている
 * (= 到達不能な) ハンドラの許可リスト (#989)。**空のまま維持するのが理想**で、
 * 追加するときは「なぜ登録しないのに残すのか」を必ず併記すること。単に
 * 「まだ配線していない」は理由にならない — `lib.rs` へ登録して `tauri.ts` に
 * ラッパを足すか、コマンドごと削除すること (#907 の `INTENTIONALLY_UNREACHABLE`
 * と同じ思想)。現時点で正当な理由は無い。
 */
const INTENTIONALLY_UNREGISTERED: string[] = [];

const rustSources = Object.values(commandModules);

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
        "capture",
        "captureRowCap",
        "captureRetentionDays",
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

  it("lib.rs に登録済みのコマンドが rustSources の自動列挙から漏れていない (取りこぼし検知、#921)", () => {
    // `rustSources` を `commands/*.rs` の import.meta.glob で自動導出しているため
    // 通常は起こり得ないが、コマンドが commands/ 以外のファイルに定義される・
    // ファイル名が glob パターンから外れる、といった将来の変更で再びモジュール
    // 単位の取りこぼしが起きないよう、lib.rs 登録集合を正として突き合わせる。
    const registered = extractRegisteredCommands(libRs);
    const missing = [...registered].filter((name) => !backendParams.has(name)).sort();
    expect(
      missing,
      `rustSources (commands/*.rs) から引数情報を抽出できていない登録コマンド: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("commands/*.rs の全 #[tauri::command] が lib.rs の generate_handler! に登録されている (#989)", () => {
    // これまでのパリティ検査は「集合の一部」しか見ていなかった:
    //   - ipcCommandParity.test.ts は lib.rs 登録集合 == tauri.ts 呼び出し集合を強制。
    //   - 上のテストは lib.rs 登録集合 ⊆ backendParams (取りこぼし検知) だけを見る。
    // どちらも「#[tauri::command] を実装したが generate_handler! に登録せず、
    // tauri.ts のラッパも作っていない」コマンドを検出できない。コマンド関数は
    // すべて pub async fn なので rlib の公開 API と見なされ、rustc の dead_code にも
    // ならず clippy -D warnings もすり抜ける。knip は TS 専用で Rust を見ない。
    // ここで backendParams (= commands/*.rs の全 #[tauri::command] 名) が
    // registered (= lib.rs の generate_handler! 登録集合) の部分集合であることを
    // 強制し、未登録の到達不能ハンドラを検出する (#907 のバックエンド版)。
    const registered = extractRegisteredCommands(libRs);
    const unregistered = [...backendParams.keys()]
      .filter((name) => !registered.has(name))
      .filter((name) => !INTENTIONALLY_UNREGISTERED.includes(name))
      .sort();
    expect(
      unregistered,
      `generate_handler! に未登録の #[tauri::command] (到達不能): ${unregistered.join(", ")}`,
    ).toEqual([]);
  });

  it("INTENTIONALLY_UNREGISTERED が実態と合っている (登録されたエントリは外す)", () => {
    const registered = extractRegisteredCommands(libRs);
    const stale = INTENTIONALLY_UNREGISTERED.filter(
      (name) => !backendParams.has(name) || registered.has(name),
    ).sort();
    expect(stale, `不要になった許可リストのエントリ: ${stale.join(", ")}`).toEqual([]);
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
