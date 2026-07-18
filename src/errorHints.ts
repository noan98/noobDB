import type { I18nKey } from "./i18n";

// Maps a raw database error string to a beginner-friendly hint key, or null
// when nothing matches. Patterns cover the wording used by MySQL, PostgreSQL
// and SQLite (all three drivers this app can connect to). The first matching
// pattern wins, so more specific checks must come before broader ones.

/**
 * エラー状態に対応するイラスト種別。
 * illustrations.tsx の各コンポーネント名に対応する文字列リテラルで表す。
 * - "connectionFailed": サーバに到達できない / 接続失敗
 * - "timeout": クエリやセッションがタイムアウト
 * - "permissionDenied": 認証失敗 / アクセス拒否 / 権限不足
 * - "schemaLoadFailed": スキーマ読み込み失敗 (テーブル/カラム/データベース不明含む)
 * - "queryFailed": その他のクエリエラー (構文エラー・制約違反など)
 */
export type ErrorIllustrationKind =
  | "connectionFailed"
  | "timeout"
  | "permissionDenied"
  | "schemaLoadFailed"
  | "queryFailed";

/**
 * エラーメッセージ文字列からイラスト種別を選択する。
 * `matchErrorHint` と同じ PATTERNS を補完する形で使う。
 * null を返すことはなく、常に何らかの種別を返す (フォールバックは "queryFailed")。
 */
export function illustrationForError(raw: string): ErrorIllustrationKind {
  // 接続失敗: サーバへの到達不能 / 接続切断。
  // "connection timed out" のように接続失敗系の文言にも "timed out" が含まれるため、
  // 下の timeout 判定より必ず先に評価する。そうしないと「到達不能」を意味する
  // メッセージが「クエリタイムアウト」イラストに誤分類され、matchErrorHint が返す
  // ヒント (接続先の確認を促す errorHintConnection) と食い違ってしまう。
  if (
    /connection refused|(?:can't|cannot|couldn't|could not) connect|connection reset|connection timed out|server has gone away|lost connection|broken pipe|connection was killed|server closed the connection|terminating connection|error communicating with database/i.test(
      raw,
    )
  )
    return "connectionFailed";
  // タイムアウト: Rust バックエンドの AppError::Timeout の文言と sqlx の pool タイムアウト
  // (上の接続失敗パターンに一致しない、クエリ/ロック等のタイムアウトのみここに残る)。
  if (/timed? ?out|timeout/i.test(raw)) return "timeout";
  // 権限不足: 認証失敗 / アクセス拒否
  if (/access denied|authentication failed|password authentication failed|permission denied|insufficient privilege/i.test(raw))
    return "permissionDenied";
  // スキーマ系: テーブル/カラム/データベースが存在しない
  if (
    /unknown column|no such column|column .* does(?:n't| not) exist|unknown database|database .* does(?:n't| not) exist|table .* does(?:n't| not) exist|no such table|relation .* does not exist/i.test(
      raw,
    )
  )
    return "schemaLoadFailed";
  // その他 (構文エラー・制約違反など)
  return "queryFailed";
}

const PATTERNS: { test: RegExp; key: I18nKey }[] = [
  { test: /sql syntax|syntax error/i, key: "errorHintSyntax" },
  {
    test: /unknown column|no such column|column .* does(?:n't| not) exist/i,
    key: "errorHintUnknownColumn",
  },
  {
    test: /unknown database|database .* does(?:n't| not) exist/i,
    key: "errorHintUnknownDatabase",
  },
  {
    test: /table .* does(?:n't| not) exist|no such table|relation .* does not exist/i,
    key: "errorHintTableNotExist",
  },
  { test: /foreign key constraint/i, key: "errorHintForeignKey" },
  { test: /duplicate entry|duplicate key|unique constraint/i, key: "errorHintDuplicate" },
  {
    test: /access denied|authentication failed|password authentication failed/i,
    key: "errorHintAccessDenied",
  },
  // Connection dropped mid-session (server closed an idle connection, socket
  // broke, network/VPN drop). Must precede the generic "can't connect" pattern
  // so a lost connection gets the reconnect-oriented hint, not the "check host"
  // one. Covers MySQL ("gone away" / "lost connection" / "broken pipe"),
  // PostgreSQL ("terminating connection" / "server closed the connection") and
  // sqlx's transport wording ("error communicating with database").
  {
    test: /server has gone away|lost connection|broken pipe|connection was killed|server closed the connection|terminating connection|error communicating with database/i,
    key: "errorHintConnectionLost",
  },
  {
    test: /connection refused|(?:can't|cannot|couldn't|could not) connect|connection reset|connection timed out/i,
    key: "errorHintConnection",
  },
];

export function matchErrorHint(raw: string): I18nKey | null {
  for (const { test, key } of PATTERNS) {
    if (test.test(raw)) return key;
  }
  return null;
}

// ── kind による確実な分類 (#683) ──
//
// バックエンドの `AppError` は `{ kind, message }` で届く (`src/api/tauri.ts` が
// `BackendError` へ正規化)。`kind` はバリアント由来の安定した判別子なので、ドライバや
// 依存クレートの文言変更に影響されず確実に分類できる。`matchErrorHint` の文字列
// パターンはあくまでフォールバック (旧形式の生文字列エラーや、`kind` だけでは
// 区別できない SSH のサブ種別のため) として残す。
//
// SSH の `kind` は `ssh` / `sshKey` / `sshHostKeyMismatch` の 3 つしかないため、
// 認証失敗・エージェント不在・鍵/パスフレーズ問題の細分は `ssh` kind 内で message を
// 見て判定する (バックの `AppError::Ssh` はこれらを 1 バリアントに集約しているため)。

/** `ssh` kind のメッセージを認証失敗 / エージェント不在 / 一般 SSH へ細分する。 */
function sshHintForMessage(message: string): I18nKey {
  // エージェント関連 (identity 無し・ソケット未接続など) を最優先で拾う。
  if (/ssh-agent|ssh agent|SSH_AUTH_SOCK|no identities/i.test(message)) {
    return "errorHintSshAgent";
  }
  // 認証拒否 (公開鍵/パスワード/エージェントいずれの失敗も message に authentication
  // /auth が入る)。
  if (/authentication|auth (?:error|failed)|permission denied/i.test(message)) {
    return "errorHintSshAuth";
  }
  // それ以外は接続/鍵交換など一般的な SSH トンネル確立失敗。
  return "errorHintSsh";
}

/**
 * `AppError.kind` から確実にヒントキーを選ぶ。対応するヒントが無い kind
 * (内部エラーや UI 別経路で案内するもの) では null を返し、呼び出し側が message の
 * 文字列マッチにフォールバックできるようにする。
 */
export function hintForKind(kind: string | null | undefined, message = ""): I18nKey | null {
  switch (kind) {
    case "sshHostKeyMismatch":
      return "errorHintSshHostKey";
    case "sshKey":
      return "errorHintSshKey";
    case "ssh":
      return sshHintForMessage(message);
    case "timeout":
      return "errorHintTimeout";
    case "connectTimeout":
      // A whole-attempt timeout points at reachability (host/port/tunnel), so
      // reuse the "couldn't reach the server" hint (#684).
      return "errorHintConnection";
    case "connectionLost":
      return "errorHintConnectionLost";
    // `db` (一般的な sqlx エラー) は具体的なヒントが message 依存なので、ここでは
    // 判定せず matchErrorHint にフォールバックさせる。その他の内部エラー
    // (sessionNotFound / invalidInput / readOnly ...) はヒント対象外。
    default:
      return null;
  }
}

/**
 * 構造化エラー (`{ kind, message }`) からヒントキーを解決する 2 段構成の入口 (#683)。
 * まず `kind` で確実に分類し、該当が無ければ従来どおり `message` の文字列パターンに
 * フォールバックする。`kind` を持たない旧形式の生文字列エラーは `matchErrorHint` の
 * 経路だけが効く (後方互換)。
 */
export function resolveErrorHint(err: {
  kind?: string | null;
  message: string;
}): I18nKey | null {
  return hintForKind(err.kind, err.message) ?? matchErrorHint(err.message);
}

/**
 * PATTERNS に登録されている全ヒントキー (登録順、重複なし)。
 *
 * ゴールデンベクタテスト (`errorHintGolden.test.ts`、#667) が、共有フィクスチャの
 * ケースが全キーを少なくとも 1 回踏んでいるかを動的に検証するために公開する
 * (到達しない = dead なヒントの検出)。新しい PATTERNS エントリを追加すれば、この
 * 配列にも自動的に反映される。
 */
export const ALL_ERROR_HINT_KEYS: I18nKey[] = PATTERNS.map((p) => p.key);
