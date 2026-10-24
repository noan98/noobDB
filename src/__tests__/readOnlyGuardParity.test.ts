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
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      for (const f of byName.get(cur) ?? []) {
        reachable += `${f.body}\n`;
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
  "list_schema_objects",
  "list_table_comments",
  "list_tables",
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
  [REASON.SCRATCH]: () => null,
  [REASON.LIFECYCLE]: () => null,
};

// ---------------------------------------------------------------------------
// 実ソースの抽出
// ---------------------------------------------------------------------------

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
