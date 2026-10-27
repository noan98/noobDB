import { describe, expect, it } from "vitest";

// read_only「書き込みコマンド網羅」パリティ (#1778)。
//
// `read_only` は CLAUDE.md が「バックエンド強制」と定める中核の安全網だが、強制は各コマンドが
// **個別に手書きチェック** (`ensure_allowed_for_session` / `session.read_only` など) している
// だけで、判定ロジック `is_read_only_sql` を固定する `readOnlyGolden.test.ts` は「SQL 文字列の
// 分類」しか見ない。SQL 文字列を経由しない書き込み経路 (同期適用・インポート・転送・サンドボックス
// など) の新規コマンドがチェックを忘れても、clippy・knip・既存ゴールデンのどれも検出せず、
// read_only プロファイルで静かに書き込みが通ってしまう。
//
// ここでは `src-tauri/src/commands/**/*.rs` の `#[tauri::command]` を機械抽出し (抽出ロジックは
// `commandRegistrationParity` / `serdeCoverageParity` と同じ `import.meta.glob` + `?raw` 方式)、
// **すべてのコマンドが次のどちらかに分類されている**ことを強制する:
//
//   - `WRITE_CAPABLE`   : DB へ書き込み得る / クライアントが渡した SQL を実行する。コマンド本体
//                         (または本体から辿れる同ファイルの関数) にガード参照を要求する
//   - `READ_ONLY_SAFE`  : 書き込まない・または read_only 強制の対象外であることを理由つきで宣言
//                         (理由ごとに機械検証できる範囲は検証する。下の `SAFE_CHECKS`)
//
// 落ちる条件: 未分類のコマンド / 分類表に残った存在しないコマンド / 両方に載っているコマンド /
// WRITE_CAPABLE なのにガード参照が無いコマンド / READ_ONLY_SAFE の理由と実装が食い違うコマンド。
//
// ガード参照の判定は**コメント・文字列リテラルを除いたコード**で行う (コメントに
// `ensure_allowed_for_session` と書いただけでは数えない)。実装の挙動 (実際に ReadOnly を返すか)
// は `tests/sqlite_integration.rs::read_only_session_rejects_every_representative_write_command`
// が SQLite で固定する。

const commandModules = import.meta.glob("../../src-tauri/src/commands/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

// ---------------------------------------------------------------------------
// Rust ソースの簡易字句処理
// ---------------------------------------------------------------------------

/**
 * 行コメント・ブロックコメント・文字列/バイト列/raw 文字列・文字リテラルの**中身を空白に潰す**
 * (改行は残す)。引用符は残すので、構文上の位置関係は保たれる。波括弧を含む文字列
 * (`format!("{x}")` など) がブレース対応を壊さないこと、コメント / 文字列中の語が
 * ガード参照として数えられないことの両方を担う。
 */
function blankNonCode(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += blank(src.slice(i, stop));
      i = stop;
    } else if (c === "/" && d === "*") {
      // Rust のブロックコメントは入れ子にできる。
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      out += blank(src.slice(i, j));
      i = j;
    } else if (
      (c === "r" || (c === "b" && d === "r")) &&
      /^b?r#*"/.test(src.slice(i, i + 12)) &&
      !/[A-Za-z0-9_]/.test(src[i - 1] ?? "")
    ) {
      // raw 文字列 r"..." / r#"..."# / br"..."
      const m = /^b?r(#*)"/.exec(src.slice(i, i + 12));
      const hashes = m?.[1] ?? "";
      const open = (m?.[0] ?? "").length;
      const close = `"${hashes}`;
      const end = src.indexOf(close, i + open);
      const stop = end === -1 ? n : end + close.length;
      out += `"${blank(src.slice(i + open, stop - close.length))}"`;
      i = stop;
    } else if (c === '"' || (c === "b" && d === '"' && !/[A-Za-z0-9_]/.test(src[i - 1] ?? ""))) {
      const start = c === '"' ? i + 1 : i + 2;
      let j = start;
      while (j < n && src[j] !== '"') {
        j += src[j] === "\\" ? 2 : 1;
      }
      out += `"${blank(src.slice(start, j))}"`;
      i = j + 1;
    } else if (c === "'") {
      // 文字リテラル ('x' / '\n' / '\u{..}') とライフタイム ('a) を区別する。
      const m = /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'/.exec(src.slice(i, i + 14));
      if (m) {
        out += `'${blank(m[0].slice(1, -1))}'`;
        i += m[0].length;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** `#[cfg(test)] mod xxx { ... }` を丸ごと潰す (テスト内の関数・語を実コードとして数えない)。 */
function dropTestModules(code: string): string {
  const re = /#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+\w+\s*\{/g;
  let out = code;
  let m: RegExpExecArray | null = re.exec(out);
  while (m !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(out, open);
    out = out.slice(0, m.index) + out.slice(close + 1).replace(/^/, " ");
    re.lastIndex = m.index;
    m = re.exec(out);
  }
  return out;
}

/** `open` 位置の `{` に対応する `}` の位置 (潰し済みコード前提。見つからなければ末尾)。 */
function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === "{") depth++;
    else if (code[j] === "}") {
      depth--;
      if (depth === 0) return j;
    }
  }
  return code.length - 1;
}

interface RustFn {
  name: string;
  /** `fn name` から本体直前の `{` まで (引数・戻り値型を含むシグネチャ)。 */
  signature: string;
  body: string;
}

/** コード中のすべての `fn` (メソッド含む) を、シグネチャと本体つきで列挙する。 */
function extractFns(code: string): RustFn[] {
  const fns: RustFn[] = [];
  const re = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null = re.exec(code);
  while (m !== null) {
    let paren = 0;
    let i = m.index + m[0].length;
    let open = -1;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === "(") paren++;
      else if (c === ")") paren--;
      else if (c === "{" && paren === 0) {
        open = i;
        break;
      } else if (c === ";" && paren === 0) break; // 宣言のみ (トレイトなど)
    }
    if (open !== -1) {
      const close = matchBrace(code, open);
      fns.push({
        name: m[1],
        signature: code.slice(m.index, open),
        body: code.slice(open, close + 1),
      });
    }
    m = re.exec(code);
  }
  return fns;
}

interface CommandInfo {
  name: string;
  file: string;
  signature: string;
  /** コマンド本体 + 本体から辿れる同ファイル関数の本体を連結したコード。 */
  reachable: string;
  /** 到達した関数ごとの本体 (関数名 → 本体。同名は連結)。 */
  fnBodies: Record<string, string>;
}

const COMMAND_RE =
  /#\[tauri::command\](?:\s*#\[[^\]]*\])*\s*(?:pub(?:\([a-z]+\))?\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;

/** 本体中に `name(` / `name::<..>(` の形で現れるか (メソッド呼び出し `.name(` も含む)。 */
function calls(body: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${name}\\s*(?:::\\s*<[^>]*>\\s*)?\\(`).test(body);
}

/** 1 ファイル分のソースから、`#[tauri::command]` 関数とその到達コードを抽出する。 */
function extractCommands(file: string, rawSource: string): CommandInfo[] {
  const code = dropTestModules(blankNonCode(rawSource));
  const fns = extractFns(code);
  const byName = new Map<string, RustFn[]>();
  for (const f of fns) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);

  const result: CommandInfo[] = [];
  COMMAND_RE.lastIndex = 0;
  let m: RegExpExecArray | null = COMMAND_RE.exec(code);
  while (m !== null) {
    const name = m[1];
    const own = byName.get(name) ?? [];
    // 同ファイル内の関数を呼び出し単位で辿る (`apply_sync_sql` → `apply_sync_sql_inner`、
    // `transfer_data` → `prepare_transfer` → `prepare_transfer_with` など)。
    const seen = new Set<string>([name]);
    const queue = [name];
    let reachable = "";
    const fnBodies: Record<string, string> = {};
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      for (const f of byName.get(cur) ?? []) {
        reachable += `${f.body}\n`;
        fnBodies[f.name] = `${fnBodies[f.name] ?? ""}${f.body}\n`;
        for (const other of byName.keys()) {
          if (!seen.has(other) && calls(f.body, other)) {
            seen.add(other);
            queue.push(other);
          }
        }
      }
    }
    result.push({
      name,
      file,
      signature: own.map((f) => f.signature).join("\n"),
      reachable,
      fnBodies,
    });
    m = COMMAND_RE.exec(code);
  }
  return result;
}

// ---------------------------------------------------------------------------
// ガード参照
// ---------------------------------------------------------------------------

/** 一次ガード: これらの参照自体が read_only を判定して `AppError::ReadOnly` を返す。 */
const PRIMARY_GUARD_RE = /\bensure_allowed_for_session\b|\b(?:session|sandbox)\.read_only\b/;

/**
 * ヘルパ経由のガード。本体が直接ガードを書かず、これらを呼ぶことで間接的にガードを通るもの。
 * 各ヘルパの本体に一次ガードが実在することも検証する (ヘルパからガードが消えたら落ちる)。
 *   - run_query_transaction_guarded_inner : 渡された全文を `ensure_allowed_for_session` に通してから
 *     トランザクション実行する。セル編集 (`bulk_update_cells`) はこの経路で影響行数を検算しつつ書き込む (#1777)。
 *   - run_query_inner             : `run_query` の本体。実行前に `ensure_allowed_for_session`。
 *   - run_in_transaction_inner    : 明示トランザクション内の実行。同じく実行前に検査。
 */
const GUARD_HELPERS = [
  "run_query_transaction_guarded_inner",
  "run_query_inner",
  "run_in_transaction_inner",
] as const;

/**
 * 自身はガードを書かず、ガードヘルパへ丸ごと委ねるだけの関数 (委譲先を必ず呼ぶことを検証する)。
 *   - run_query_transaction_inner : 検算なしで `run_query_transaction_guarded_inner` に委ねる。
 *     Undo/Redo (`*_flight_record` / `apply_flight_batch`) と `run_query_transaction` はこの経路。
 */
const GUARD_DELEGATES: Record<string, (typeof GUARD_HELPERS)[number]> = {
  run_query_transaction_inner: "run_query_transaction_guarded_inner",
};

function hasGuard(reachableCode: string): boolean {
  return (
    PRIMARY_GUARD_RE.test(reachableCode) ||
    GUARD_HELPERS.some((h) => calls(reachableCode, h)) ||
    Object.keys(GUARD_DELEGATES).some((d) => calls(reachableCode, d))
  );
}

// ---------------------------------------------------------------------------
// 分類
// ---------------------------------------------------------------------------

/**
 * 書き込み得る / クライアント供給の SQL を実行するコマンド。各エントリは
 * `why` (どのガードを通るか) と `guards` (到達コード内に**すべて**現れるべき必須ガードの正規表現) を持つ。
 * 「どこかにガード語が現れる」では、同ファイルの無関係な関数のガードや条件付き検査
 * (`ensure_broadcast_read_only` は force_read_only 時のみ) を拾って、本物のガードを消しても
 * 落ちなくなるため、コマンドごとに拒否の形まで照合する。
 */
interface WriteCapable {
  why: string;
  guards: RegExp[];
}
const ESA_SESSION = /\bensure_allowed_for_session\s*\(\s*&session\b/;
const wc = (why: string, ...guards: RegExp[]): WriteCapable => ({ why, guards });
const VIA_TX = wc(
  "run_query_transaction(_guarded)_inner 経由 (全文を ensure_allowed_for_session)",
  /\brun_query_transaction(?:_guarded)?_inner\s*\(/,
);
const RO_IF_SESSION = /\bif\s+session\.read_only\s*\{/;
const RO_IF_SANDBOX = /\bif\s+sandbox\.read_only\s*\{/;

const WRITE_CAPABLE: Record<string, WriteCapable> = {
  // --- SQL 文字列経路: ensure_allowed_for_session (= read_only && !is_read_only_sql) ---
  run_query: wc("run_query_inner が ensure_allowed_for_session", /\brun_query_inner\s*\(/),
  run_query_stream: wc("ストリーム実行前に ensure_allowed_for_session", ESA_SESSION),
  run_query_transaction: VIA_TX,
  run_in_transaction: wc(
    "run_in_transaction_inner が ensure_allowed_for_session",
    /\brun_in_transaction_inner\s*\(/,
  ),
  run_sql_batch: wc(
    "run_statement が文ごとに ensure_allowed_for_session",
    /\bensure_allowed_for_session\s*\(\s*&self\.session\b/,
  ),
  run_sql_script: wc(
    "run_statement が文ごとに ensure_allowed_for_session",
    /\bensure_allowed_for_session\s*\(\s*&self\.session\b/,
  ),
  export_query_stream: wc("実行前に ensure_allowed_for_session", ESA_SESSION),
  export_tables_xlsx: wc("シートごとに ensure_allowed_for_session", ESA_SESSION),
  data_search_stream: wc("走査 SQL を ensure_allowed_for_session", ESA_SESSION),
  timelapse_capture: wc("ensure_allowed_for_session", /\bensure_allowed_for_session\s*\(\s*session\b/),
  timelapse_watch_table: wc("ensure_allowed_for_session", /\bensure_allowed_for_session\s*\(\s*session\b/),
  plan_watch_refresh: wc(
    "EXPLAIN SQL を ensure_allowed_for_session",
    /\bensure_allowed_for_session\s*\(\s*session\b/,
  ),
  broadcast_compare: wc(
    "ensure_allowed_for_session (+ force_read_only 時の ensure_broadcast_read_only)",
    ESA_SESSION,
  ),
  // --- 経由ヘルパのガード ---
  bulk_update_cells: VIA_TX,
  undo_flight_record: wc(
    "flight_recorder.rs の apply_flight_plan が run_query_transaction_inner 経由",
    /\brun_query_transaction_inner\s*\(/,
  ),
  redo_flight_record: wc(
    "flight_recorder.rs の apply_flight_plan が run_query_transaction_inner 経由",
    /\brun_query_transaction_inner\s*\(/,
  ),
  apply_flight_batch: VIA_TX,
  // --- SQL 文字列を経由しない書き込み経路: session.read_only を手書きで拒否 ---
  insert_generated_rows: wc("ensure_allowed_for_session (INSERT 相当で検査)", ESA_SESSION),
  apply_sync_sql: wc("session.read_only を拒否 (SQL 判定を通らない)", RO_IF_SESSION),
  apply_privilege_sql: wc("session.read_only を拒否 (SQL 判定を通らない)", RO_IF_SESSION),
  import_csv: wc(
    "ensure_import_writable が session.read_only を拒否",
    /\bensure_import_writable\s*\(/,
    RO_IF_SESSION,
  ),
  import_xlsx_sheets: wc(
    "ensure_import_writable が session.read_only を拒否",
    /\bensure_import_writable\s*\(/,
    RO_IF_SESSION,
  ),
  transfer_data: wc(
    "ensure_transfer_target_writable が転送先の session.read_only を拒否",
    /\bensure_transfer_target_writable\s*\(/,
    RO_IF_SESSION,
  ),
  preview_transfer: wc(
    "転送元の SQL を ensure_allowed_for_session (転送先は書き込まないので read_only でも可)",
    /\bensure_allowed_for_session\s*\(\s*&source\b/,
  ),
  kill_processes: wc("session.read_only を拒否 (KILL / pg_cancel_backend)", RO_IF_SESSION),
  sqlite_maintenance: wc(
    "action.writes() && session.read_only を拒否",
    /\baction\.writes\(\)\s*&&\s*session\.read_only\b/,
  ),
  sandbox_advance_base: wc("sandbox.read_only を拒否", RO_IF_SANDBOX),
  sandbox_reset_table: wc("sandbox.read_only を拒否", RO_IF_SANDBOX),
};

/**
 * READ_ONLY_SAFE の理由カテゴリ。`SAFE_CHECKS` が理由ごとに実装との整合を機械検証する。
 * 理由の文面は報告・レビュー向けの説明を兼ねる。
 */
const REASON = {
  /** DB セッションを受け取らない (ローカルストア・ファイル・設定・OS 連携・AI のみ)。 */
  LOCAL_ONLY: "DB セッションを受け取らず、ローカルのストア / ファイル / 設定のみを扱う",
  /** セッションを使うがメタデータ取得・SELECT・統計取得などの読み取りのみ。 */
  SESSION_READ: "セッションを使うが読み取り専用の問い合わせのみ (書き込み系ドライバ呼び出しを持たない)",
  /** SQL 文字列を生成 / 解析するだけで実行しない。 */
  GENERATE_ONLY: "SQL の生成 / 解析のみで DB へ実行しない (適用は WRITE_CAPABLE 側のコマンド)",
  /** 実行する SQL を read-only 文に限定する独自ガードを持つ (read_only 設定と無関係に常時)。 */
  SELF_GUARDED: "is_read_only_sql(_for) / run_lookup_query で read-only 文以外を常時拒否する",
  /** 書き込みプレビュー (dry-run)。常にロールバックし、read_only でも許可する仕様。 */
  DRY_RUN: "常にロールバックする書き込みプレビュー (dry-run)。read_only でも許可する仕様",
  /** BEGIN / SAVEPOINT など。中の文は run_in_transaction が検査する。 */
  TX_CONTROL: "トランザクション制御のみ。実行する文の検査は run_in_transaction が担う",
  /** サンドボックス / ローカルセッションなど、ユーザの DB と別のスクラッチ領域を操作する。 */
  SCRATCH: "ユーザの DB ではなくサンドボックス / ローカルのスクラッチ領域だけを書く",
  /** 接続の確立・切断・状態フラグ切替。 */
  LIFECYCLE: "接続の確立 / 切断 / フラグ切替であり、DB へ書き込まない",
} as const;
type Reason = (typeof REASON)[keyof typeof REASON];

const SAFE: Record<string, Reason> = {};
function safe(reason: Reason, ...names: string[]) {
  for (const n of names) {
    if (n in SAFE) throw new Error(`READ_ONLY_SAFE に重複: ${n}`);
    SAFE[n] = reason;
  }
}

safe(
  REASON.LOCAL_ONLY,
  // AI
  "clear_ai_usage_history",
  "get_ai_usage_history",
  "has_ai_api_key",
  "run_ai_request",
  "set_ai_api_key",
  "test_ai_connection",
  // アサーション定義の CRUD (実行は run_assertion = SELF_GUARDED)
  "delete_assertion",
  "export_assertions",
  "import_assertions",
  "list_assertions",
  "restore_assertion",
  "save_assertion",
  // ファイル / OS
  "read_binary_file",
  "write_binary_file",
  "write_text_file",
  "read_sql_file",
  "read_text_file",
  "reveal_in_file_manager",
  "open_project_link",
  "preview_sql_file_encodings",
  "install_dump_tool",
  "dump_tool_status",
  // 履歴
  "clear_history",
  "delete_history_entries",
  "get_history_retention_days",
  "get_history_sql",
  "get_history_sqls",
  "list_history",
  "list_history_sql",
  "set_history_retention_days",
  // インポート (ファイル解析 / テンプレート / スキップ行)
  "get_import_skipped_text",
  "parse_csv_preview",
  "save_import_skipped_rows",
  "delete_import_template",
  "list_import_templates",
  "save_import_template",
  // ログ / 診断
  "build_diagnostic_bundle",
  "clear_logs",
  "clear_perf_samples",
  "get_perf_status",
  "read_logs",
  "set_perf_enabled",
  // プロファイル / 鍵 / SSH
  "check_keyring",
  "delete_profile",
  "delete_skipped_profile",
  "export_profiles",
  "import_profiles",
  "list_profiles",
  "list_skipped_profiles",
  "reorder_profiles",
  "reveal_profile_secret",
  "save_profile",
  "export_profiles_encrypted",
  "import_profiles_encrypted",
  "forget_host_key",
  "import_known_hosts",
  "list_known_hosts",
  "list_known_hosts_history",
  "resolve_ssh_config_host",
  "scan_openssh_known_hosts",
  "trust_host_key",
  // スニペット
  "delete_snippet",
  "export_snippets",
  "import_snippets",
  "list_snippets",
  "preview_import_snippets",
  "save_snippet",
  // タスク定義 / スケジューラ設定
  "clear_task_runs",
  "delete_task",
  "get_scheduler_settings",
  "list_assertion_runs",
  "list_task_runs",
  "list_tasks",
  "preview_task_schedule",
  "save_task",
  "set_scheduler_settings",
  "set_task_enabled",
  // フライトレコーダ / タイムラプス / スキーマドリフト / プラン監視 (ローカル記録)
  "clear_flight_records",
  "export_flight_records",
  "list_flight_records",
  "pin_flight_record",
  "timelapse_clear_all",
  "timelapse_diff_generations",
  "timelapse_list_watches",
  "timelapse_row_history",
  "timelapse_unwatch",
  "schema_drift_compare",
  "schema_drift_import_legacy",
  "schema_drift_list",
  "schema_drift_set_label",
  "plan_watch_import_legacy",
  "plan_watch_list",
  "plan_watch_set",
  // 結果ハンドル (メモリ上の結果セットの加工)
  "release_result",
  "render_export_text",
  "result_column_stats",
  "result_duplicate_keys",
  "result_find",
  "result_sort_filter",
  "export_query_result",
  "mask_export_rows",
  // その他
  "set_window_title",
  "cancel_stream",
  "release_data_diffs",
  "list_sandboxes",
  "cancel_connect",
);

safe(
  REASON.SESSION_READ,
  // スキーマ / メタデータ
  "alter_table_context",
  "describe_database",
  "describe_table",
  "describe_table_extras",
  "foreign_keys",
  "get_object_definition",
  "get_routine_signature",
  "incoming_foreign_keys",
  "invalidate_table_cache",
  "list_databases",
  "list_indexes",
  "list_table_triggers",
  "list_schema_objects",
  "list_table_comments",
  "list_tables",
  "plan_sqlite_table_rebuild",
  "refresh_schema_cache",
  "schema_cache_times",
  "schema_overview",
  "table_row_estimate",
  "column_dependencies",
  "table_row_estimates",
  "table_statistics",
  "list_tables_all",
  "load_schema_tree",
  "open_table",
  "open_tables",
  "find_where_used",
  "search_schema_objects",
  "ignore_advisor_finding",
  "unignore_advisor_finding",
  "export_flight_plan_sql",
  "list_local_tables",
  // 診断 / 統計 / 監視
  "analyze_schema_health",
  "check_duplicate_index",
  "profile_column",
  "profile_table",
  "server_info",
  "server_metrics",
  "list_processes",
  "get_process_query",
  "get_process_queries",
  "list_db_users",
  "list_user_privileges",
  "query_stats_support",
  "sample_live_queries",
  "sample_statement_delta",
  "start_statement_recording",
  // セル BLOB 読み出し (保存先はローカルファイル)
  "fetch_cell_bytes",
  "probe_cell_blob",
  "save_cell_to_file",
  "save_cells_to_folder",
  // 比較 / ダンプ (読み出して差分 / ファイルを作るだけ)
  "compare_schema",
  "compare_table_data",
  "dump_database",
  // 履歴付きの参照
  "preview_flight_batch",
  "preview_redo",
  "preview_undo",
  "schema_drift_capture",
  "sandbox_schema_diff",
  "sandbox_table_diff",
);

safe(
  REASON.GENERATE_ONLY,
  "broadcast_sync_sql",
  "preview_assertion_sql",
  "generate_alter_password_sql",
  "generate_create_user_sql",
  "generate_drop_user_sql",
  "generate_privilege_diff_sql",
  "generate_role_membership_sql",
  "generate_data_sync_sql",
  "generate_sync_sql",
  "preview_create_table_ddl",
  "schema_drift_revert_sql",
  "analyze_sql_script",
);

safe(REASON.SELF_GUARDED, "run_lookup_query", "run_assertion", "suggest_accepted_values", "run_task_now");

safe(REASON.DRY_RUN, "preview_query_stream", "import_dry_run");

safe(
  REASON.TX_CONTROL,
  "begin_transaction",
  "finish_transaction",
  "create_savepoint",
  "release_savepoint",
  "rollback_to_savepoint",
);

safe(
  REASON.SCRATCH,
  "create_sandbox",
  "discard_sandbox",
  "create_local_session",
  "drop_local_table",
  "register_local_table",
  "save_local_database",
);

safe(
  REASON.LIFECYCLE,
  "connect",
  "reconnect",
  "disconnect",
  "test_connection",
  "health_probe_all",
  "ping_session",
  "session_tunnel_alive",
  "set_emergency_mode",
);

/**
 * READ_ONLY_SAFE の理由ごとの機械検証。理由と実装が食い違ったら落ちる
 * (例: 「SESSION_READ」のコマンドに書き込み系ドライバ呼び出しが入った、
 *  「LOCAL_ONLY」のコマンドが session_id を受け取るようになった)。
 */
const WRITE_DRIVER_CALL_RE =
  /\b(?:execute_transaction|execute_in_transaction|execute_sync_transaction|import_rows|drop_local_table|sqlite_maintenance|kill_process\w*)\s*\(/;
const EXECUTE_CALL_RE = /\.\s*execute(?:_[a-z_]+)?\s*\(/;
/**
 * SESSION_READ のうち、内部で組み立てた SELECT を `execute` するコマンド (クライアント供給の SQL は
 * 実行しない)。ここに無いコマンドが `execute` に到達したら、読み取りのつもりでも要レビュー。
 */
const SESSION_READ_EXECUTES_SELECT = new Set([
  "fetch_cell_bytes",
  "probe_cell_blob",
  "save_cell_to_file",
  "save_cells_to_folder",
  "compare_schema",
  "compare_table_data",
  "dump_database",
  "sandbox_table_diff",
]);

/**
 * SCRATCH / LIFECYCLE 用のドライバ呼び出し検出 (#1882)。`WRITE_DRIVER_CALL_RE` / `EXECUTE_CALL_RE` は
 * 「その種の呼び出しが在るか」しか見ず、メソッド名の列挙は取りこぼす (`import_rows_skipping` など)。
 * そこで**既定拒否**にする: 到達コード内の `…conn.<method>(…)` はすべて抽出し、
 *   - `impl Connection` の読み取り専用メソッド (`CONNECTION_READ_METHODS`) なら無条件で可
 *   - それ以外 (書き込み / SQL 実行 / 未分類) はコマンドごとの許可リスト (`受け手.メソッド`) に無ければ失格
 * とする。`impl Connection` の `pub fn` は全件「読み取り / 書き込み・実行」のどちらかに分類済みである
 * ことを別テストが強制するので、新メソッドが増えたら分類のために落ちる。
 * 書き込み・実行系のメソッド名は受け手が `conn` でなくても (`session.drop_local_table(` など) 検出する。
 * 受け手が式 (`state.get(..).await?.conn.x(`) の場合は受け手を追えないので許可外にする。
 * 解析は同一ファイル内で辿れる関数に限る (他モジュールの関数の中身は見ない)。
 */
const CONNECTION_READ_METHODS = new Set([
  "driver_kind",
  "connect",
  "transaction_active",
  "health_check",
  "resolve_database",
  "check_upsert_keys",
  "table_is_transactional",
  "databases",
  "tables",
  "columns",
  "generated_columns",
  "columns_for_database",
  "indexes_for_database",
  "row_identity",
  "schema_overview",
  "schema_overview_all",
  "object_definitions_bulk",
  "foreign_keys",
  "cross_schema_incoming_foreign_keys",
  "foreign_keys_for_table",
  "schema_objects",
  "object_definition",
  "table_ddl_extras",
  "ddl_extras_for_database",
  "routine_signature",
  "list_indexes",
  "list_table_triggers",
  "resolve_row_key",
  "table_row_estimates",
  "table_row_estimate",
  "tables_all",
  "table_comments",
  "generated_column_exprs",
  "table_sizes",
  "server_version",
  "server_info",
  "server_metrics",
  "connection_count",
  "list_processes",
  "list_processes_without_locks",
  "list_db_users",
  "user_privileges",
  "query_stats_support",
  "live_queries",
  "statement_stats",
  "unused_indexes",
  "column_profile",
  "table_profile",
  "close",
  "fetch_rows_by_pk",
  "list_local_tables",
]);
/** 書き込み / SQL 実行 / 状態変更を行う `impl Connection` のメソッド (許可リストに無ければ到達不可)。 */
const CONNECTION_WRITE_METHODS = new Set([
  "execute",
  "execute_explain",
  "create_table_from_columns",
  "begin_transaction",
  "begin_transaction_with",
  "execute_in_transaction",
  "execute_tx_control",
  "finish_transaction",
  "preview_execute_with_limit",
  "execute_stream",
  "import_rows_with_binary",
  "import_rows",
  "try_insert_chunk",
  "probe_failing_row",
  "dry_run_failures",
  "import_rows_skipping",
  "execute_transaction",
  "execute_transaction_guarded",
  "execute_sync_transaction",
  "kill_processes",
  "capture_write",
  "capture_prepare",
  "capture_execute",
  "capture_commit",
  "register_local_table",
  "drop_local_table",
  "sqlite_maintenance",
  "vacuum_into",
]);
/** 引数 1 つ目に SQL 文字列を取るメソッド。LIFECYCLE ではその引数が固定リテラルであることを要求する。 */
const SQL_ARG_METHODS = new Set([
  "execute",
  "execute_explain",
  "execute_in_transaction",
  "execute_tx_control",
  "execute_stream",
  "execute_transaction",
  "execute_transaction_guarded",
  "execute_sync_transaction",
  "preview_execute_with_limit",
  "capture_prepare",
  "capture_commit",
]);

interface DriverCall {
  /** 空白を除いた受け手 (`source.conn` など)。式の受け手は `<expr>` で始まる。自由関数呼び出しは空文字。 */
  receiver: string;
  method: string;
  /** 1 つ目の引数 (対応する `)` か深さ 0 の `,` まで。文字列リテラルの中身は空白に潰れている)。 */
  firstArg: string;
}

/** `open` 位置の `(` の直後から、1 つ目の引数のテキストを返す。 */
function firstArgOf(code: string, open: number): string {
  let depth = 0;
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return code.slice(open + 1, i);
      depth--;
    } else if (c === "," && depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

/** `conn` で終わる受け手のメソッド呼び出し、または書き込み系メソッド名の呼び出し (受け手不問) を列挙する。 */
function driverCalls(code: string): DriverCall[] {
  const out: DriverCall[] = [];
  const re = /(?<![A-Za-z0-9_])([A-Za-z_]\w*)\s*(?:::\s*<[^>]*>\s*)?\(/g;
  let m: RegExpExecArray | null = re.exec(code);
  while (m !== null) {
    const method = m[1];
    // 後方固定幅だけを見る (全体を毎回 slice すると O(n^2))。受け手の連鎖は 256 文字に収まる。
    const before = code.slice(Math.max(0, m.index - 256), m.index).replace(/\s+$/, "");
    let receiver = "";
    let isMethod = false;
    if (before.endsWith(".")) {
      isMethod = true;
      const prefix = before.slice(0, -1).replace(/\s+$/, "");
      const chain = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)$/.exec(prefix);
      if (chain) {
        receiver = chain[1].replace(/\s+/g, "");
        const head = prefix.slice(0, chain.index).replace(/\s+$/, "");
        if (/[)\]?.]$/.test(head)) receiver = `<expr>${receiver}`;
      } else {
        receiver = "<expr>";
      }
    }
    const lastSeg = receiver
      .replace(/^<expr>/, "")
      .split(".")
      .pop();
    const relevant = CONNECTION_WRITE_METHODS.has(method) || (isMethod && lastSeg === "conn");
    if (relevant) {
      out.push({ receiver, method, firstArg: firstArgOf(code, m.index + m[0].length - 1) });
    }
    m = re.exec(code);
  }
  return out;
}

const callKey = (c: DriverCall) => (c.receiver === "" ? c.method : `${c.receiver}.${c.method}`);
/** 文字列リテラルだけ (= クライアント供給の SQL ではない固定文)。 */
const LITERAL_ONLY_ARG = /^\s*"\s*"\s*$/;
/**
 * コマンドがクライアント供給の SQL / 文を引数に取っているか。**限界**: 見るのは引数名だけ。
 * `request: SomeRequest` のような構造体や別名 (`text` / `body`) の引数に SQL が入っていても検出できない。
 * その穴は許可リスト (ドライバ呼び出しの受け手固定) と実挙動の統合テストが補う。
 */
const CLIENT_SQL_PARAM_RE = /\b(?:sql|statements?|queries|query)\s*:/;

/** 到達コード内のパス付き呼び出し (`crate::a::b::f(` / `super::f(`) を列挙する。 */
function pathCalls(code: string): string[] {
  return [
    ...code.matchAll(
      /(?<![A-Za-z0-9_:])((?:crate|super)(?:\s*::\s*[A-Za-z_]\w*)+)\s*(?:::\s*<[^>]*>\s*)?\(/g,
    ),
  ].map((m) => m[1].replace(/\s+/g, ""));
}

/**
 * SCRATCH の許可ドライバ呼び出し (読み取り系メソッドは `CONNECTION_READ_METHODS` で常に可)。
 * キーに無いコマンドは**書き込み・実行系の呼び出しに一切到達してはならない**。
 *   - create_sandbox: 元 DB へは `source.conn.execute` (内部で組み立てた SELECT) だけ。書き込みは
 *     自前で張った SQLite ファイルの接続 `conn` に対してのみ。
 *   - *_local_table / save_local_database: `get_local_session` で検証したローカルセッションの SQLite。
 */
const SCRATCH_ALLOWED_CALLS: Record<string, string[]> = {
  create_sandbox: ["source.conn.execute", "conn.execute_transaction", "conn.import_rows"],
  drop_local_table: ["session.conn.drop_local_table"],
  register_local_table: ["session.conn.register_local_table"],
  save_local_database: ["session.conn.vacuum_into"],
};

/** SCRATCH の許可パス付き呼び出し。ここに無いパス付き呼び出しに到達したら要レビュー。 */
// 空のメモリ内キャッシュを作るだけ (セッション構築で使う)
const SESSION_CACHES = ["crate::cache::SchemaCache::default", "crate::cache::QueryResultCache::default"];
const SCRATCH_ALLOWED_PATHS: Record<string, string[]> = {
  create_sandbox: SESSION_CACHES,
  create_local_session: SESSION_CACHES,
  // メモリ上の結果ハンドルから行を読み出すだけ (DB へは触れない)。
  register_local_table: ["crate::commands::result::resolve_rows"],
};

/**
 * SCRATCH が「ユーザの DB ではないこと」を担保する必須の足場。セッションを受け取るコマンドは
 * ローカルセッション / サンドボックスのセッションであることを検証してから使う
 * (`state.get(session_id)` に差し替わるとユーザの DB に触れてしまう)。
 */
const SCRATCH_REQUIRED: Record<string, RegExp[]> = {
  create_sandbox: [
    // クライアント供給の抽出条件は read-only の条件だけに絞って元 DB の SELECT へ入れる。
    /\bchecked_row_filter\s*\(/,
    // 書き込み先は新規に作った SQLite ファイルへ張った接続 (ユーザの接続ではない)。
    /\blet\s+conn\s*=\s*match\s+Connection::connect\s*\(\s*&opts\s*\)/,
    /\bdriver\s*:\s*DriverKind::Sqlite\b/,
  ],
  discard_sandbox: [/\bget_sandbox_session\s*\(/],
  drop_local_table: [/\bget_local_session\s*\(/],
  register_local_table: [/\bget_local_session\s*\(/],
  save_local_database: [/\bget_local_session\s*\(/],
};

/** LIFECYCLE の許可ドライバ呼び出し (SQL を取るものは固定文 `SELECT 1` の疎通確認のみ。引数がリテラルであることも検査する)。 */
const LIFECYCLE_ALLOWED_CALLS: Record<string, string[]> = {
  // 接続テストは自前で張った一時接続 `conn` で疎通するだけ。
  test_connection: ["conn.execute"],
  // 再接続前に、トランザクションを掴んだ旧接続の生死を見る / 強制再接続で旧トランザクションを破棄する。
  reconnect: ["old.conn.execute_in_transaction", "old.conn.finish_transaction"],
};

const LIFECYCLE_ALLOWED_PATHS: Record<string, string[]> = {
  connect: SESSION_CACHES,
  reconnect: SESSION_CACHES,
  test_connection: SESSION_CACHES,
};

/** LIFECYCLE の必須の足場。 */
const LIFECYCLE_REQUIRED: Record<string, RegExp[]> = {
  // 緊急書き込みモードは read_only セッションにだけ有効化できる (書き込み可能セッションでは拒否)。
  set_emergency_mode: [/\benabled\s*&&\s*!\s*session\.read_only\b/],
};

/**
 * 接続変数 `conn` の束縛。`conn` という名前の受け手を「自前で張った一時接続」と信用する許可リスト
 * (`conn.execute_transaction` など) は、`conn` の正体が 1 か所の束縛で固定されている前提で成り立つ。
 * 再束縛・クロージャ引数・`for` 変数などで別の接続 (ユーザのセッション) に化けないよう、束縛はちょうど 1 か所で
 * 指定の形であることを要求する。
 */
const CONN_BINDING_PATTERNS: RegExp[] = [
  /\blet\s+(?:mut\s+)?conn\b/g,
  /\blet\s*\([^)]*\bconn\b[^)]*\)/g,
  /\|\s*(?:mut\s+)?conn\s*(?::[^|]*)?\|/g,
  /\bfor\s+conn\s+in\b/g,
  /\bconn\s*=\s*&/g,
];
const CONN_BINDING_REQUIRED: Record<string, { fn: string; re: RegExp }> = {
  create_sandbox: {
    fn: "create_sandbox_inner",
    re: /\blet\s+conn\s*=\s*match\s+Connection::connect\s*\(\s*&opts\s*\)/,
  },
  test_connection: {
    fn: "test_connection",
    re: /\blet\s*\(\s*\w+\s*,\s*\w+\s*,\s*conn\s*\)\s*=\s*open_connection\s*\(/,
  },
};

/**
 * 接続の流出: フィールドの `….conn` を値のまま (`.` で続けず) 渡す形。受け取り側で別名を付けられると
 * 受け手の許可リストをすり抜けるので失格にする。**残る穴**: `Session` ごと (`session` / `&session`) 別の関数へ
 * 渡す形は検出できない (関数側の解析は同一ファイルの到達コードに限られる)。
 */
const CONN_LEAK_RE = /\b\w+(?:\s*\.\s*\w+)*\s*\.\s*conn\b(?!\s*\.)/;

/** 呼び出しごとの引数の固定。`reconnect` の強制再接続は旧トランザクションを必ず rollback (false) する。 */
const CALL_ARG_PINS: Record<string, RegExp> = {
  "old.conn.finish_transaction": /^\s*false\s*$/,
};

/** SCRATCH / LIFECYCLE 共通: 許可リスト・必須の足場・クライアント SQL 引数の有無を検査する。 */
function checkScratchLike(
  c: CommandInfo,
  allowed: Record<string, string[]>,
  allowedPaths: Record<string, string[]>,
  required: Record<string, RegExp[]>,
  literalOnly: boolean,
): string | null {
  if (CLIENT_SQL_PARAM_RE.test(c.signature)) {
    return "クライアント供給の SQL / 文を引数に取る (WRITE_CAPABLE へ移しガードを入れる)";
  }
  const permitted = allowed[c.name] ?? [];
  for (const call of driverCalls(c.reachable)) {
    const key = callKey(call);
    const isRead = CONNECTION_READ_METHODS.has(call.method) && !call.receiver.startsWith("<expr>");
    if (!isRead && !permitted.includes(key)) {
      const kind = CONNECTION_WRITE_METHODS.has(call.method) ? "" : " (impl Connection 未分類のメソッド?)";
      return `許可されていないドライバ呼び出しに到達する: ${key}(...)${kind} (ユーザの DB へ書き込む経路になっていないか確認し、正当なら許可リストへ理由つきで追加する)`;
    }
    const pin = CALL_ARG_PINS[key];
    if (pin && !pin.test(call.firstArg)) {
      return `${key}(...) の第 1 引数が固定値ではない: ${pin}`;
    }
    if (literalOnly && SQL_ARG_METHODS.has(call.method) && !LITERAL_ONLY_ARG.test(call.firstArg)) {
      return `${key}(...) の引数が固定の文字列リテラルではない (クライアント供給の SQL を実行していないか)`;
    }
  }
  const leak = CONN_LEAK_RE.exec(c.reachable);
  if (leak) {
    return `接続をフィールドごと値で渡している: ${leak[0]} (受け手の許可リストをすり抜ける恐れ)`;
  }
  const binding = CONN_BINDING_REQUIRED[c.name];
  if (binding) {
    const bindingRe = binding.re;
    // 束縛は接続を張る関数の本体 (binding.fn) で数える。他の下請け関数の同名ローカルは別スコープ。
    const scope = c.fnBodies[binding.fn] ?? c.fnBodies[c.name] ?? "";
    const count = CONN_BINDING_PATTERNS.reduce((n, re) => n + (scope.match(re)?.length ?? 0), 0);
    if (count !== 1 || !bindingRe.test(scope)) {
      return `conn の束縛が指定の 1 か所ではない (束縛 ${count} 件。再束縛・クロージャ引数・for 変数は不可): ${bindingRe}`;
    }
  }
  const okPaths = allowedPaths[c.name] ?? [];
  const badPath = pathCalls(c.reachable).find((p) => !okPaths.includes(p));
  if (badPath) {
    return `許可されていないパス付き呼び出しに到達する: ${badPath}(...) (別モジュールの書き込み関数でないか確認し、正当なら許可リストへ追加する)`;
  }
  const lacking = (required[c.name] ?? []).filter((r) => !r.test(c.reachable));
  if (lacking.length > 0) return `必須の足場が到達コードに無い: ${lacking.join(", ")}`;
  return null;
}

const SAFE_CHECKS: Record<Reason, (c: CommandInfo) => string | null> = {
  [REASON.LOCAL_ONLY]: (c) =>
    /session/i.test(c.signature)
      ? "シグネチャに session を含む (LOCAL_ONLY ではなく SESSION_READ / WRITE_CAPABLE を検討)"
      : null,
  [REASON.SESSION_READ]: (c) => {
    if (WRITE_DRIVER_CALL_RE.test(c.reachable)) {
      return "書き込み系のドライバ呼び出しに到達する (WRITE_CAPABLE へ移しガードを入れる)";
    }
    if (EXECUTE_CALL_RE.test(c.reachable) && !SESSION_READ_EXECUTES_SELECT.has(c.name)) {
      return "SQL 文字列を execute する (内部で組み立てた SELECT のみなら SESSION_READ_EXECUTES_SELECT へ、そうでなければ WRITE_CAPABLE へ)";
    }
    return null;
  },
  [REASON.GENERATE_ONLY]: (c) =>
    WRITE_DRIVER_CALL_RE.test(c.reachable) || EXECUTE_CALL_RE.test(c.reachable)
      ? "SQL を実行するドライバ呼び出しに到達する (GENERATE_ONLY ではない)"
      : null,
  [REASON.SELF_GUARDED]: (c) =>
    /\bis_read_only_sql(?:_for)?\b|\brun_lookup_query_inner\b/.test(c.reachable)
      ? null
      : "is_read_only_sql(_for) / run_lookup_query_inner への参照が無い",
  [REASON.DRY_RUN]: (c) =>
    /\bpreview_execute_with_limit\b|\bdry_run\w*\b|\brollback\w*\b/i.test(c.reachable)
      ? null
      : "ロールバック / dry-run の実装への参照が無い",
  [REASON.TX_CONTROL]: (c) =>
    WRITE_DRIVER_CALL_RE.test(c.reachable) ||
    /\b(?:begin_transaction\w*|finish_transaction|execute_tx_control|savepoint_inner)\b/.test(c.reachable)
      ? null
      : "トランザクション制御の呼び出しが見当たらない",
  [REASON.SCRATCH]: (c) =>
    checkScratchLike(c, SCRATCH_ALLOWED_CALLS, SCRATCH_ALLOWED_PATHS, SCRATCH_REQUIRED, false),
  [REASON.LIFECYCLE]: (c) =>
    checkScratchLike(c, LIFECYCLE_ALLOWED_CALLS, LIFECYCLE_ALLOWED_PATHS, LIFECYCLE_REQUIRED, true),
};

// ---------------------------------------------------------------------------
// 実ソースの抽出
// ---------------------------------------------------------------------------

const allRustSources = import.meta.glob("../../src-tauri/src/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const commands: CommandInfo[] = Object.entries(commandModules).flatMap(([file, src]) =>
  extractCommands(file.replace(/^.*\/commands\//, ""), src),
);
const byName = new Map(commands.map((c) => [c.name, c]));

/** 全 commands/**.rs の関数本体 (ヘルパの実在検証用)。 */
const allFns = Object.values(commandModules).flatMap((src) => extractFns(dropTestModules(blankNonCode(src))));

describe("read_only 書き込みコマンド網羅パリティ (#1778)", () => {
  it("抽出の下限: #[tauri::command] を取りこぼさず十分な件数を抽出する", () => {
    // 2026-10 時点で 220 件超。0 件 / 激減で黙ってパスしないための下限。
    expect(commands.length).toBeGreaterThan(200);
    // 字句処理後のコードに現れる `#[tauri::command` の総数と抽出件数が一致する
    // (`#[tauri::command(rename_all = ..)]` など正規表現が拾えない記法の追加を検出)。
    const occurrences = Object.values(commandModules).reduce(
      (sum, src) => sum + (dropTestModules(blankNonCode(src)).match(/#\[tauri::command/g) ?? []).length,
      0,
    );
    expect(commands.length).toBe(occurrences);
    // 名前の重複は無い (重複していると分類表が曖昧になる)。
    expect(byName.size).toBe(commands.length);
  });

  it("分類の下限: WRITE_CAPABLE / READ_ONLY_SAFE がそれぞれ空でない", () => {
    expect(Object.keys(WRITE_CAPABLE).length).toBeGreaterThan(20);
    expect(Object.keys(SAFE).length).toBeGreaterThan(150);
  });

  it("すべてのコマンドが WRITE_CAPABLE か READ_ONLY_SAFE のどちらかに分類されている", () => {
    const unclassified = commands.map((c) => c.name).filter((n) => !(n in WRITE_CAPABLE) && !(n in SAFE));
    expect(
      unclassified,
      `未分類のコマンド: ${unclassified.join(", ")}\n` +
        "新しい #[tauri::command] は readOnlyGuardParity.test.ts の WRITE_CAPABLE (書き込み得る / " +
        "クライアント供給の SQL を実行する。本体に read_only ガードを入れる) か READ_ONLY_SAFE " +
        "(理由つき) に分類すること (#1778)",
    ).toEqual([]);
  });

  it("両方の表に載っているコマンドは無い", () => {
    const both = Object.keys(WRITE_CAPABLE).filter((n) => n in SAFE);
    expect(both).toEqual([]);
  });

  it("分類表に残った存在しないコマンドは無い (削除・改名の取り残し)", () => {
    const stale = [...Object.keys(WRITE_CAPABLE), ...Object.keys(SAFE)].filter((n) => !byName.has(n));
    expect(stale).toEqual([]);
  });

  it("WRITE_CAPABLE のコマンドは必須ガードの形を到達コードに持つ", () => {
    const missing = Object.entries(WRITE_CAPABLE).flatMap(([n, w]) => {
      const c = byName.get(n);
      if (c === undefined) return [];
      const lacking = w.guards.filter((g) => !g.test(c.reachable));
      return lacking.length > 0 ? [`${n} (${w.why}): ${lacking.join(", ")}`] : [];
    });
    expect(
      missing,
      `必須の read_only ガードが無い書き込みコマンド:\n${missing.join("\n")}\n` +
        "ガードを本体 (または呼び先の *_inner) に戻すこと。read_only は『バックエンド強制』の" +
        "安全網なので、このテストを緩めて通さない",
    ).toEqual([]);
  });

  it("ガードヘルパは本体に一次ガードを実際に持つ", () => {
    for (const helper of GUARD_HELPERS) {
      const defs = allFns.filter((f) => f.name === helper);
      expect(defs.length, `${helper} の定義が見つからない`).toBeGreaterThan(0);
      expect(
        defs.some((f) => PRIMARY_GUARD_RE.test(f.body)),
        `${helper} の本体に一次ガード参照が無い (ヘルパ経由のガードが空洞化している)`,
      ).toBe(true);
    }
    for (const [delegate, helper] of Object.entries(GUARD_DELEGATES)) {
      const defs = allFns.filter((f) => f.name === delegate);
      expect(defs.length, `${delegate} の定義が見つからない`).toBeGreaterThan(0);
      expect(
        defs.some((f) => calls(f.body, helper)),
        `${delegate} が ${helper} へ委ねていない (委譲経由のガードが空洞化している)`,
      ).toBe(true);
    }
  });

  it("SCRATCH / LIFECYCLE の許可リストは実在する分類済みコマンドだけを指し、取り残しが無い (#1882)", () => {
    const stale: string[] = [];
    const tables: [string, Record<string, unknown>, Reason][] = [
      ["SCRATCH_ALLOWED_CALLS", SCRATCH_ALLOWED_CALLS, REASON.SCRATCH],
      ["SCRATCH_REQUIRED", SCRATCH_REQUIRED, REASON.SCRATCH],
      ["LIFECYCLE_ALLOWED_CALLS", LIFECYCLE_ALLOWED_CALLS, REASON.LIFECYCLE],
      ["LIFECYCLE_REQUIRED", LIFECYCLE_REQUIRED, REASON.LIFECYCLE],
    ];
    for (const [label, table, reason] of tables) {
      for (const name of Object.keys(table)) {
        if (SAFE[name] !== reason) stale.push(`${label}: ${name} は ${reason} に分類されていない`);
      }
    }
    // 許可した呼び出しが実際に到達コードに現れる (消えた呼び出しの許可が残らない)。
    const allowed: [Record<string, string[]>][] = [[SCRATCH_ALLOWED_CALLS], [LIFECYCLE_ALLOWED_CALLS]];
    for (const [table] of allowed) {
      for (const [name, keys] of Object.entries(table)) {
        const seen = new Set(driverCalls(byName.get(name)?.reachable ?? "").map(callKey));
        for (const k of keys) if (!seen.has(k)) stale.push(`${name}: 許可した ${k} が到達コードに無い`);
      }
    }
    // 許可したパス付き呼び出しも到達コードに実在する。
    for (const table of [SCRATCH_ALLOWED_PATHS, LIFECYCLE_ALLOWED_PATHS]) {
      for (const [name, paths] of Object.entries(table)) {
        const seen = new Set(pathCalls(byName.get(name)?.reachable ?? ""));
        for (const p of paths) if (!seen.has(p)) stale.push(`${name}: 許可した ${p} が到達コードに無い`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("impl Connection の pub fn は全件『読み取り / 書き込み・実行』に分類されている (#1882)", () => {
    // src-tauri/src 全体の `impl Connection { .. }` を集める (別ファイルの追加 impl も分類の対象)。
    const methods: string[] = [];
    for (const src of Object.values(allRustSources)) {
      const code = blankNonCode(src);
      const implRe = /^[ \t]*impl\s+(?:(?:crate::db::|super::)?Connection)\b\s*\{/gm;
      let im: RegExpExecArray | null = implRe.exec(code);
      while (im !== null) {
        const open = im.index + im[0].length - 1;
        const block = code.slice(open, matchBrace(code, open) + 1);
        for (const m of block.matchAll(/\n {4}pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+(\w+)/g))
          methods.push(m[1]);
        im = implRe.exec(code);
      }
    }
    expect(methods.length).toBeGreaterThan(50);
    const unclassified = methods.filter(
      (m) => !CONNECTION_READ_METHODS.has(m) && !CONNECTION_WRITE_METHODS.has(m),
    );
    expect(
      unclassified,
      `impl Connection の未分類メソッド: ${unclassified.join(", ")}\n` +
        "readOnlyGuardParity.test.ts の CONNECTION_READ_METHODS (読み取りのみ) か CONNECTION_WRITE_METHODS (書き込み・実行) に分類すること (#1882)",
    ).toEqual([]);
    const both = [...CONNECTION_READ_METHODS].filter((m) => CONNECTION_WRITE_METHODS.has(m));
    expect(both).toEqual([]);
    const stale = [...CONNECTION_READ_METHODS, ...CONNECTION_WRITE_METHODS].filter(
      (m) => !methods.includes(m),
    );
    expect(stale, "分類表に残った存在しないメソッド").toEqual([]);
  });

  it("READ_ONLY_SAFE の理由と実装が食い違うコマンドは無い", () => {
    const problems: string[] = [];
    for (const [name, reason] of Object.entries(SAFE)) {
      const c = byName.get(name);
      if (!c) continue;
      const problem = SAFE_CHECKS[reason](c);
      if (problem) problems.push(`${name} (${reason}): ${problem}`);
    }
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 自己検証 (合成ソース): 抽出・ガード判定ロジック自体が壊れたら落ちる
// ---------------------------------------------------------------------------

function analyze(src: string): Map<string, CommandInfo> {
  return new Map(extractCommands("synthetic.rs", src).map((c) => [c.name, c]));
}

describe("read_only パリティ自体の自己検証 (合成ソース)", () => {
  it("本体の直接ガードは検出する", () => {
    const m = analyze(`
      #[tauri::command]
      pub async fn w(state: State<'_, AppState>) -> Result<()> {
          ensure_allowed_for_session(&session, "x")?;
          Ok(())
      }`);
    expect(hasGuard(m.get("w")?.reachable ?? "")).toBe(true);
  });

  it("ガードが無いコマンドは検出されない (ネガティブ)", () => {
    const m = analyze(`
      #[tauri::command]
      pub async fn w() -> Result<()> { session.conn.execute("DELETE FROM t", None).await }`);
    expect(hasGuard(m.get("w")?.reachable ?? "")).toBe(false);
  });

  it("コメント内のガード参照は数えない", () => {
    const m = analyze(`
      #[tauri::command]
      pub async fn w() -> Result<()> {
          // ensure_allowed_for_session(&session, sql)?;
          /* if session.read_only { return Err(AppError::ReadOnly(String::new())); } */
          /// session.read_only
          Ok(())
      }`);
    expect(hasGuard(m.get("w")?.reachable ?? "")).toBe(false);
  });

  it("文字列リテラル内のガード参照は数えない", () => {
    const m = analyze(`
      #[tauri::command]
      pub async fn w() -> Result<()> {
          let s = "ensure_allowed_for_session(session.read_only)";
          let r = r#"if session.read_only { "x" }"#;
          tracing::info!("{}", s);
          Ok(())
      }`);
    expect(hasGuard(m.get("w")?.reachable ?? "")).toBe(false);
  });

  it("波括弧を含む文字列リテラルがあってもブレース対応は壊れない", () => {
    const m = analyze(`
      #[tauri::command]
      pub async fn a() -> Result<()> { let _ = format!("{{ {x} }}"); let c = '{'; Ok(()) }
      #[tauri::command]
      pub async fn b() -> Result<()> { ensure_allowed_for_session(&s, "x")?; Ok(()) }`);
    expect(hasGuard(m.get("a")?.reachable ?? "")).toBe(false);
    expect(hasGuard(m.get("b")?.reachable ?? "")).toBe(true);
  });

  it("同ファイルの *_inner / 下請け関数のガードは本体のガードとして数える", () => {
    const m = analyze(`
      #[tauri::command]
      pub async fn w(state: State<'_, AppState>) -> Result<()> { w_inner(state.inner()).await }
      pub(crate) async fn w_inner(state: &AppState) -> Result<()> { prepare(state).await }
      async fn prepare(state: &AppState) -> Result<()> {
          if session.read_only { return Err(AppError::ReadOnly(String::new())); }
          Ok(())
      }
      #[tauri::command]
      pub async fn unrelated() -> Result<()> { Ok(()) }`);
    expect(hasGuard(m.get("w")?.reachable ?? "")).toBe(true);
    // 呼ばれていない関数のガードは別コマンドへ波及しない。
    expect(hasGuard(m.get("unrelated")?.reachable ?? "")).toBe(false);
  });

  it("無関係な関数のガードしか到達しないコマンドは必須ガードの照合で失敗する", () => {
    const m = analyze(`
      #[tauri::command]
      pub async fn w(state: State<'_, AppState>) -> Result<()> {
          ensure_allowed_for_session(&source, "x")?;
          ensure_broadcast_read_only(driver, "x")?;
          Ok(())
      }`);
    const reachable = m.get("w")?.reachable ?? "";
    // 別の一次ガード (転送元側) や条件付き検査があっても、このコマンドが要求する形でなければ不合格。
    expect(RO_IF_SESSION.test(reachable)).toBe(false);
    expect(ESA_SESSION.test(reachable)).toBe(false);
    // ensure_broadcast_read_only は一次ガードではない。
    expect(hasGuard("ensure_broadcast_read_only(driver, sql)?;")).toBe(false);
  });

  it("ガードヘルパ呼び出しは間接ガードとして数える", () => {
    const m = analyze(`
      #[tauri::command]
      pub async fn w(state: State<'_, AppState>) -> Result<()> {
          run_query_transaction_inner(state.inner(), s, v, None).await?; Ok(())
      }`);
    expect(hasGuard(m.get("w")?.reachable ?? "")).toBe(true);
  });

  it("#[cfg(test)] モジュール内のガード参照は数えない", () => {
    const m = analyze(`
      #[tauri::command]
      pub async fn w() -> Result<()> { helper().await }
      async fn helper() -> Result<()> { Ok(()) }
      #[cfg(test)]
      mod tests {
          async fn helper() { ensure_allowed_for_session(&s, "x").unwrap(); }
      }`);
    expect(hasGuard(m.get("w")?.reachable ?? "")).toBe(false);
  });

  it("追加属性・pub(crate)・非 pub のコマンドも抽出する (コメント中の記法は無視)", () => {
    const m = analyze(`
      // #[tauri::command] pub fn commented() {}
      #[tauri::command]
      #[allow(clippy::too_many_arguments)]
      pub async fn one() {}
      #[tauri::command]
      pub(crate) fn two() {}
      #[tauri::command]
      async fn three() {}`);
    expect([...m.keys()].sort()).toEqual(["one", "three", "two"]);
  });

  it("SCRATCH: 許可外の受け手へのドライバ呼び出しに到達すると落ちる (#1882)", () => {
    const run = (src: string, name: string) => {
      const c = analyze(src).get(name);
      return c ? SAFE_CHECKS[REASON.SCRATCH](c) : "抽出できない";
    };
    // 許可済みの呼び出しだけなら通る。
    expect(
      run(
        `#[tauri::command]
         pub async fn create_sandbox(name: String) -> Result<()> {
             checked_row_filter(d, t, f)?;
             let o = DbConnectOptions { driver: DriverKind::Sqlite };
             let conn = match Connection::connect(&opts).await { Ok(c) => c, Err(e) => return Err(e) };
             source.conn.execute(&sql, None).await?;
             conn
                 .import_rows(None, t, c, r)
                 .await?;
             Ok(())
         }`,
        "create_sandbox",
      ),
    ).toBeNull();
    // 元 DB (source) への書き込み系呼び出しは許可外。
    expect(
      run(
        `#[tauri::command]
         pub async fn create_sandbox(name: String) -> Result<()> {
             checked_row_filter(d, t, f)?;
             let o = DbConnectOptions { driver: DriverKind::Sqlite };
             let conn = match Connection::connect(&opts).await { Ok(c) => c, Err(e) => return Err(e) };
             source.conn.execute_transaction(&ddl, None).await?;
             Ok(())
         }`,
        "create_sandbox",
      ),
    ).toContain("source.conn.execute_transaction");
    // 許可リストに無いコマンドは、ユーザセッションへ execute を持った時点で落ちる。
    expect(
      run(
        `#[tauri::command]
         pub async fn discard_sandbox(id: String) -> Result<()> {
             get_sandbox_session(s, r, i).await?;
             let session = state.get(&id).await;
             session.conn.execute("DELETE FROM t", None).await?;
             Ok(())
         }`,
        "discard_sandbox",
      ),
    ).toContain("session.conn.execute");
    // 自由関数形の書き込み呼び出しも検出する。
    expect(
      run(
        `#[tauri::command]
         pub async fn register_local_table() -> Result<()> {
             get_local_session(s, i).await?;
             sqlite_maintenance(x).await
         }`,
        "register_local_table",
      ),
    ).toContain("sqlite_maintenance");
    // 必須の足場 (ローカルセッション検証) が無いと落ちる。
    expect(
      run(
        `#[tauri::command]
         pub async fn drop_local_table(t: String) -> Result<()> {
             let session = state.get(&t).await;
             session.conn.drop_local_table(&t).await
         }`,
        "drop_local_table",
      ),
    ).toContain("必須の足場");
    // クライアント供給の SQL を引数に取るなら WRITE_CAPABLE へ。
    expect(
      run(
        `#[tauri::command]
         pub async fn save_local_database(sql: String) -> Result<()> { get_local_session(s, i).await?; Ok(()) }`,
        "save_local_database",
      ),
    ).toContain("クライアント供給");
  });

  it("LIFECYCLE: 固定文以外の実行・許可外の呼び出しに到達すると落ちる (#1882)", () => {
    const run = (src: string, name: string) => {
      const c = analyze(src).get(name);
      return c ? SAFE_CHECKS[REASON.LIFECYCLE](c) : "抽出できない";
    };
    expect(
      run(
        `#[tauri::command]
         pub async fn test_connection() -> Result<()> { let (tunnel, _opts, conn) = open_connection(&req, &progress, secs).await?; conn.execute("SELECT 1", None).await?; Ok(()) }`,
        "test_connection",
      ),
    ).toBeNull();
    // リテラルではなく変数の SQL を流すと落ちる。
    expect(
      run(
        `#[tauri::command]
         pub async fn test_connection() -> Result<()> { let (tunnel, _opts, conn) = open_connection(&req, &progress, secs).await?; conn.execute(&init_sql, None).await?; Ok(()) }`,
        "test_connection",
      ),
    ).toContain("固定の文字列リテラルではない");
    // 接続系コマンドがユーザセッションへ書き込むと落ちる。
    expect(
      run(
        `#[tauri::command]
         pub async fn connect() -> Result<()> { session.conn.execute_transaction(&v, None).await }`,
        "connect",
      ),
    ).toContain("session.conn.execute_transaction");
    // 緊急書き込みモードの「読み書き可能セッションでは有効化を拒否」が消えると落ちる。
    expect(
      run(
        `#[tauri::command]
         pub async fn set_emergency_mode(enabled: bool) -> Result<()> { session.set_emergency_write(enabled); Ok(()) }`,
        "set_emergency_mode",
      ),
    ).toContain("必須の足場");
  });

  it("既定拒否: 列挙漏れだった書き込みメソッド・式の受け手・パス付き呼び出しも検出する (#1882)", () => {
    const run = (reason: Reason, src: string, name: string) => {
      const c = analyze(src).get(name);
      return c ? SAFE_CHECKS[reason](c) : "抽出できない";
    };
    for (const method of [
      "import_rows_skipping",
      "import_rows_with_binary",
      "create_table_from_columns",
      "begin_transaction_with",
      "finish_transaction",
      "capture_write",
      "register_local_table",
      "vacuum_into",
    ]) {
      expect(
        run(
          REASON.LIFECYCLE,
          `#[tauri::command]
           pub async fn connect() -> Result<()> { session.conn.${method}(x).await }`,
          "connect",
        ),
        method,
      ).toContain(`session.conn.${method}`);
    }
    // 式の受け手は追えないので、読み取りメソッドでも許可外。
    expect(
      run(
        REASON.LIFECYCLE,
        `#[tauri::command]
         pub async fn connect() -> Result<()> { state.get(id).await?.conn.columns(a, b).await }`,
        "connect",
      ),
    ).toContain("<expr>");
    // 読み取りメソッドは受け手が conn なら可。
    expect(
      run(
        REASON.LIFECYCLE,
        `#[tauri::command]
         pub async fn connect() -> Result<()> { session.conn.columns(a, b).await; conn.close().await; Ok(()) }`,
        "connect",
      ),
    ).toBeNull();
    // 許可外のパス付き呼び出し。
    expect(
      run(
        REASON.SCRATCH,
        `#[tauri::command]
         pub async fn discard_sandbox(id: String) -> Result<()> {
             get_sandbox_session(s, r, i).await?;
             crate::other::wipe_user_table(x).await
         }`,
        "discard_sandbox",
      ),
    ).toContain("crate::other::wipe_user_table");
    // bool 引数 (finish_transaction(false)) は SQL 引数ではないので LIFECYCLE の許可済みなら通る。
    expect(
      run(
        REASON.LIFECYCLE,
        `#[tauri::command]
         pub async fn reconnect() -> Result<()> { old.conn.finish_transaction(false).await }`,
        "reconnect",
      ),
    ).toBeNull();
    // 1 つ目の引数が長いリテラル/変数でも切り出しは対応する括弧まで (先頭 40 文字では判定しない)。
    expect(
      run(
        REASON.LIFECYCLE,
        `#[tauri::command]
         pub async fn test_connection() -> Result<()> {
             let (tunnel, _opts, conn) = open_connection(&req, &progress, secs).await?; 
             conn.execute("SELECT 1 /* ${"x".repeat(60)} */", None).await?; conn.execute(format!("{}", sql_from_client), None).await
         }`,
        "test_connection",
      ),
    ).toContain("固定の文字列リテラルではない");
  });

  it("conn の再束縛・接続の流出・finish_transaction の引数を検出する (#1882)", () => {
    const BIND = "let (tunnel, _opts, conn) = open_connection(&req, &progress, secs).await?;";
    const run = (src: string, name: string, reason: Reason = REASON.LIFECYCLE) => {
      const c = analyze(src).get(name);
      return c ? SAFE_CHECKS[reason](c) : "抽出できない";
    };
    const tc = (body: string) =>
      `#[tauri::command]
       pub async fn test_connection() -> Result<()> { ${BIND} ${body} Ok(()) }`;
    expect(run(tc('conn.execute("SELECT 1", None).await?;'), "test_connection")).toBeNull();
    // 再束縛 / クロージャ引数 / for 変数 / 参照での差し替え。
    for (const body of [
      "let conn = session.conn;",
      "let mut conn = other();",
      "items.iter().for_each(|conn| { run(conn); });",
      "for conn in all {}",
      "conn = &session.conn;",
    ]) {
      expect(run(tc(body), "test_connection"), body).not.toBeNull();
    }
    // 接続のフィールドごとの受け渡し (流出)。
    expect(run(tc("helper(&session.conn).await?;"), "test_connection")).toContain("フィールドごと");
    // finish_transaction の第 1 引数は false 固定。
    const rc = (arg: string) =>
      `#[tauri::command]
       pub async fn reconnect() -> Result<()> { old.conn.finish_transaction(${arg}).await }`;
    expect(run(rc("false"), "reconnect")).toBeNull();
    expect(run(rc("true"), "reconnect")).toContain("固定値ではない");
    expect(run(rc("commit"), "reconnect")).toContain("固定値ではない");
  });

  it("CRLF 改行でも受け手の抽出と許可判定が変わらない (#1882)", () => {
    const src = `#[tauri::command]
pub async fn create_sandbox(name: String) -> Result<()> {
    checked_row_filter(d, t, f)?;
    let o = DbConnectOptions { driver: DriverKind::Sqlite };
    let conn = match Connection::connect(&opts).await { Ok(c) => c, Err(e) => return Err(e) };
    conn
        .import_rows(None, t, c, r)
        .await?;
    Ok(())
}`.replace(/\n/g, "\r\n");
    const c = analyze(src).get("create_sandbox");
    expect(c).toBeDefined();
    expect(driverCalls(c?.reachable ?? "").map(callKey)).toEqual(["conn.import_rows"]);
    expect(c ? SAFE_CHECKS[REASON.SCRATCH](c) : "x").toBeNull();
  });

  it("実ソースの分類で、ガード参照を剥がした書き込みコマンドは落ちる", () => {
    // 実在する書き込みコマンドのソースからガード参照だけを消すと、判定が false に変わる
    // (= 実コードからガードを外したときにテストが落ちる、の合成版)。
    const real = byName.get("apply_sync_sql");
    expect(real).toBeDefined();
    expect(hasGuard(real?.reachable ?? "")).toBe(true);
    const stripped = (real?.reachable ?? "")
      .replace(/session\.read_only/g, "session.flag")
      .replace(/ensure_allowed_for_session/g, "noop");
    expect(hasGuard(stripped)).toBe(false);
  });
});
