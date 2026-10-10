import {
  forwardRef,
  memo,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Box, chakra } from "@chakra-ui/react";
import { registerTreeDropTarget } from "./treeDragStore";
import { treeItemInsertText } from "./treeDragInsert";
import { AnimatePresence, motion } from "motion/react";
import { Compartment, EditorState, StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  WidgetType,
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  selectAll,
  toggleComment,
} from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { sql, type SQLNamespace } from "@codemirror/lang-sql";
import { forceLinting, lintGutter, linter } from "@codemirror/lint";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { api, type ForeignKey, type TableColumnInfo, type TableSchema } from "../api/tauri";
import { joinCompletions } from "./sqlJoinCompletion";
import { derivedCompletions } from "./sqlDerivedCompletion";
import {
  buildSchemaNamespace,
  describeColumn,
  findColumnInfo,
  keywordCompletionOption,
  type ColumnInfoLabels,
} from "./sqlSchemaCompletion";
import { renderColumnInfo } from "./completionInfoPanel";
import { renderCompletionIcon } from "./completionIcons";
import { t, useT } from "../i18n";
import { useSettings } from "../settings";
import { springs } from "../motion";
import { statementAtOffset } from "../sqlScript";
import { diagnosticsFromTree, type SqlLintMessages } from "./sqlLint";
import { PREFLIGHT_MAX_CHARS } from "./preflight";
import { usePreflightImpact, type PreflightResult } from "./usePreflight";
import { PreflightBadge } from "./PreflightBadge";
import {
  EditorStateCache,
  sqlConfigChanged,
  type AppliedEditorConfig,
} from "./editorStateCache";
import { comboToCodeMirror } from "../shortcutKeys";
import { DEFAULT_SHORTCUT_COMBOS } from "../shortcuts";
import { QueryBuilder, type QueryBuilderSnapshot } from "./QueryBuilder";
import { AiQueryModal } from "./AiQueryModal";
import { useAiAvailable } from "../ai/useAiAvailable";
import type { AiSqlEditorAction, SqlAssistKind } from "../ai/sqlAssist";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { copyToClipboard } from "./clipboard";
import { sqlEditorMenuSpec, type SqlEditorMenuAction } from "./sqlEditorMenu";
import { formatCombo as formatComboLabel } from "../shortcutKeys";
import { labelWithShortcut } from "../shortcutLabel";
import type { ShortcutId } from "../shortcuts";
import { codeMirrorSqlDialectFor } from "./sqlDialect";
import { formatSqlAsync } from "./sqlFormat";
import { Icon, ICON_SIZES, ICON_STROKE } from "./Icon";
import { Spinner } from "./Spinner";
import { Switch } from "./Switch";
import { Button } from "./ui";
import { Tooltip } from "./Tooltip";
import { MultiStateBadge, type BadgeState } from "./MultiStateBadge";
import {
  initialHistoryNav,
  navigateNewer,
  navigateOlder,
  type HistoryNavState,
} from "./queryHistoryNav";

// ツールバーの各ボタンに `hover` / `tap` のマイクロインタラクションを共通で乗せるための
// 薄いラッパ。`Button` 自体を `motion.create` するとボタンの recipe (Chakra style props)
// 経路が複雑になるため、`motion.span` を被せる方式で済ませている。span は inline-flex
// で本体ボタンと同じレイアウト振る舞いを保つ。
// `title` は native title ではなく共有 `Tooltip` (#814/#884) へこの共通ラッパ 1 か所で
// 委譲する — 呼び出し側は従来どおり `title` を渡すだけでよい。`disabled` なボタンは
// `focusableWrapper` でキーボード到達も確保する。
function ToolbarButton({
  children,
  title,
  ...rest
}: ComponentProps<typeof Button> & { children: ReactNode }) {
  const button = (
    <motion.span
      style={{ display: "inline-flex" }}
      whileHover={!rest.disabled ? { scale: 1.04 } : undefined}
      whileTap={!rest.disabled ? { scale: 0.97 } : undefined}
      transition={springs.gentle}
    >
      <Button {...rest}>{children}</Button>
    </motion.span>
  );
  return title ? (
    <Tooltip label={title} focusableWrapper={rest.disabled}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

const noobDBHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)", fontWeight: "bold" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  {
    tag: [tags.lineComment, tags.blockComment, tags.docComment],
    color: "var(--syntax-comment)",
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--syntax-function)",
  },
  { tag: tags.operator, color: "var(--syntax-operator)" },
]);

// 「カーソル位置の文を実行」(#555) したとき、走った文を一瞬ハイライトするための
// 装飾。`stmtFlashEffect` で範囲をセット/クリアし、エディタは時間差でクリアする。
// 見た目のフェードは App.css の `.cm-stmt-flash` (reduced-motion 対応) が司る。
const stmtFlashEffect = StateEffect.define<{ from: number; to: number } | null>();
const stmtFlashMark = Decoration.mark({ class: "cm-stmt-flash" });
const stmtFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(stmtFlashEffect)) {
        deco =
          e.value && e.value.to > e.value.from
            ? Decoration.set([stmtFlashMark.range(e.value.from, e.value.to)])
            : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// スキーマツリーのテーブル / 列行をドラッグしている間 (#1414)、挿入予定位置に出す
// キャレット相当のマーカー。HTML5 の drag イベントに依存する `dropCursor` 拡張は使えない
// (ポインタ操作方式) ので、`treeDropMarkerEffect` で位置をセット/クリアする自前の装飾。
// 見た目は App.css の `.cm-tree-drop-caret`。
const treeDropMarkerEffect = StateEffect.define<number | null>();
class TreeDropCaretWidget extends WidgetType {
  eq(other: WidgetType) {
    return other instanceof TreeDropCaretWidget;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-tree-drop-caret";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}
const treeDropCaretDeco = Decoration.widget({ widget: new TreeDropCaretWidget(), side: 1 });
const treeDropMarkerField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(treeDropMarkerEffect)) {
        deco =
          e.value === null
            ? Decoration.none
            : Decoration.set([treeDropCaretDeco.range(Math.min(e.value, tr.state.doc.length))]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// リアルタイム構文チェック (#704) のデバウンス遅延 (ms)。大きなスクリプトでも
// 入力を阻害しないよう、タイプが落ち着いてから lint を走らせる。
const SQL_LINT_DELAY_MS = 500;

/** エディタの再割り当て可能なアクション (#557) の解決済みコンボ。 */
export interface EditorKeyBindings {
  run: string;
  runStatement: string;
  preview: string;
  format: string;
  /** EXPLAIN (#1113)。未指定なら既定へフォールバック。 */
  explain: string;
}

export interface SchemaTable {
  database: string;
  name: string;
  columns: string[];
}

export interface ActiveTable {
  database: string;
  name: string;
}

interface Props {
  onRun: (sql: string) => void;
  /**
   * 結果を残したまま新しいタブで実行する (#1278)。`Mod+Shift+Enter` の
   * 実行は既定ではエディタ内ではドライラン (preview) と同じキーになるため、
   * マウスでも辿れるよう「…」メニューに入口を置く。未指定ならメニュー項目を出さない。
   */
  onRunInNewTab?: (sql: string) => void;
  /** `runNewTab` の解決済みコンボ (メニュー項目のキー表記用)。 */
  runNewTabCombo?: string;
  /** True while this tab's Run is streaming — flips the Run badge to its `running` state. */
  running?: boolean;
  /** True while this tab's Dry Run preview is streaming — flips the Preview badge to `running`. */
  previewRunning?: boolean;
  onPreview?: (sql: string) => void;
  onExplain?: (sql: string) => void;
  /**
   * 環境横断ブロードキャスト実行 (#738)。渡されると「複数の接続で実行」ボタンが
   * ツールバーに現れる。読み取り専用チェック・対象接続の選択・実行そのものは
   * 呼び出し側 (`App.tsx` → `BroadcastModal`) が担い、ここは選択中/全文の SQL を
   * 渡すだけ。
   */
  onBroadcast?: (sql: string) => void;
  /**
   * 同一ドライバの接続が他に開いているか (ブロードキャストの対象になり得るか)。
   * false のときボタンは無効化され、ツールチップにその理由を出す。
   */
  broadcastAvailable?: boolean;
  onChange?: (sql: string) => void;
  /**
   * 本文が変わるたびに、その時点の不変ドキュメントを渡す (#1316)。文字列化しないので打鍵ごとに
   * 呼んでも O(1)。App はこれで「最新本文への参照」だけを保ち、`tabs` の state は更新しない
   * (打鍵ごとの App 再レンダーを避ける)。文字列が要るときに呼び出し側が `toString()` する。
   */
  onDocChange?: (doc: Text) => void;
  onFormatError?: (error: string) => void;
  onSaveSnippet?: (sql: string) => void;
  /**
   * `.sql` スクリプトの明示的な「開く」/「名前を付けて保存」(#918)。渡されると
   * ツールバーにボタンが現れる。どちらも SQL のテキストはやり取りせず (開く先は
   * 新規タブ、保存元はタブの現在値を App 側が持つ)、ダイアログ表示・ファイル I/O は
   * すべて呼び出し側 (`App.tsx`) が担う。
   */
  onOpenFile?: () => void;
  onSaveFile?: () => void;
  disabled?: boolean;
  schemaTable?: SchemaTable | null;
  /**
   * Every table/column in the editor's database, for whole-schema completion
   * (table names anywhere, and `table.column` / `alias.column` in JOINs). When
   * present it supersedes `schemaTable`, which only ever covers the one active
   * table; `schemaTable` still seeds the active table's columns while this is
   * loading and sets the default (unqualified) table.
   */
  databaseSchema?: TableSchema[] | null;
  activeTable?: ActiveTable | null;
  /**
   * 表示するタブの識別子 (#1308)。変わると `EditorView` は作り直さず、タブごとに保存した
   * `EditorState` を `setState` で差し替える (undo 履歴・選択・スクロールが保たれる)。
   * 初回に見るタブは `initialSql` から作り、保存済みのタブへ戻るときはその state を
   * 復元する (保存した本文が `initialSql` と食い違えば捨てて作り直す)。未指定なら
   * 差し替えは行わない (単一ドキュメントとしての利用)。
   */
  tabId?: string;
  initialSql?: string;
  /**
   * 復元するカーソル/選択 (ドキュメントオフセット、#678)。state を新規に作るとき
   * (初回マウントと、保存済み state の無いタブへの切替) に doc 長へクランプして適用する。
   * undefined なら先頭 (既定)。
   */
  initialSelection?: { anchor: number; head: number };
  /** カーソル/選択が変わるたびに現在のオフセットを通知する (#678。タブ永続化用)。 */
  onSelectionChange?: (selection: { anchor: number; head: number }) => void;
  sessionId?: string | null;
  defaultDatabase?: string | null;
  /**
   * When true the primary action runs EXPLAIN instead of the statement, so
   * the Run button is relabelled accordingly. Set for `explain` tabs.
   */
  explainMode?: boolean;
  driver?: string;
  /**
   * Most recent Query Builder inputs for this tab (or null). Restored when the
   * builder is reopened so iterative Dry Run / Run keeps the previous setup.
   */
  builderSnapshot?: QueryBuilderSnapshot | null;
  /** Persists the builder inputs captured on its Run / Dry Run. */
  onBuilderPersist?: (snapshot: QueryBuilderSnapshot) => void;
  /**
   * True when the active session is read-only. Passed to the Query Builder so
   * its Run button is disabled for write query kinds.
   */
  readOnly?: boolean;
  /**
   * 本番プロファイルか (#691)。AI にクエリを依頼する前に送信確認を挟むのに使う。
   */
  isProduction?: boolean;
  /**
   * AI が生成した SQL を新しいクエリタブで開く (#691。実行はしない)。
   */
  onOpenSqlInNewTab?: (sql: string, database: string | null) => void;
  /**
   * 緊急クエリ実行モード (read-only セッションの一時的な書き込み許可) の現在値。
   * `onToggleEmergencyMode` とセットで渡され、かつ `readOnly` のときだけ
   * ツールバーにトグルを表示する。有効化の合意 (接続先名のタイプ確認) は App 側の
   * ダイアログが担い、ここは表示と切替要求の通知のみ。
   */
  emergencyMode?: boolean;
  onToggleEmergencyMode?: (next: boolean) => void;
  /**
   * 直近に実行したクエリの一覧 (最新が先頭)。エディタ 1 行目での ↑ / 末尾行での ↓
   * による履歴ナビゲーションに使う。未接続時などは空/undefined。
   */
  queryHistory?: string[];
  /**
   * エディタ系ショートカット (Run / Run statement / Preview / Format) の解決済み
   * コンボ (#557)。未指定の項目は既定にフォールバックする。バインドが変わると
   * CodeMirror のキーマップを Compartment 経由で再構成する。
   */
  editorBindings?: Partial<EditorKeyBindings>;
  /**
   * エディタ集中モード (#618) の現在状態。`onToggleFocus` が渡されたときだけ
   * ツールバーに集中/復元トグルを出し、`focusMode` でアイコン/ツールチップを切り替える。
   */
  focusMode?: boolean;
  onToggleFocus?: () => void;
  /**
   * 影響行数プリフライト (#737) の結果が変わるたびに通知する。App 側はタブ単位で
   * 保持し、危険クエリ確認ダイアログへ件数を引き継ぐのに使う。
   */
  onPreflightImpact?: (result: PreflightResult | null) => void;
  /**
   * 「この SQL を解説」「最適化案を提案」(#695) の起動先。選択範囲 (無ければ全文) を渡す。
   * 結果はボトムパネルに出る。AI が使えないときは渡されても項目を出さない。
   */
  onAiSqlAction?: (action: AiSqlEditorAction) => void;
}

export interface QueryEditorHandle {
  /** Inserts text at the current cursor (replacing any selection). */
  insertText: (text: string) => void;
  /** Replaces the entire editor contents (used to restore a history entry). */
  setText: (text: string) => void;
  /** エディタ本文の全文 (#692。失敗した SQL の範囲探索用)。 */
  getText: () => string;
  /** `[from, to)` だけを置き換える。undo 履歴に載る (#692)。 */
  replaceRange: (from: number, to: number, text: string) => void;
  /** キーボードフォーカスをエディタへ移す (ペインフォーカス循環 #681)。 */
  focus: () => void;
  /**
   * コマンドパレット (#1113) からの実行系アクション。いずれもツールバー /
   * ショートカットと同じ経路 (選択 → 無ければ全文、など) を通るだけで、新しい
   * 実行経路は持たない。対象テキストが空なら何もしない。
   */
  runAll: () => void;
  /** 選択があれば選択を、無ければカーソル位置の 1 文を実行する (Mod+Alt+Enter と同じ)。 */
  runStatement: () => void;
  formatSql: () => void;
  explain: () => void;
  /** 「AI にクエリを依頼」モーダルを開く (#691。コマンドパレット用)。 */
  openAiQuery: () => void;
  /** 選択範囲 (無ければ全文) の SQL を AI で解説 / リライトする (#695。コマンドパレット用)。 */
  requestAiSql: (kind: SqlAssistKind) => void;
}

/**
 * 選択範囲 (無ければ全文) を整形して置き換える。整形 (sql-formatter) は巨大な SQL で
 * メインスレッドを塞ぐため Web Worker で実行する (#1256、`sqlFormat.ts`)。戻り値は
 * 「キー入力を消費したか」で、対象テキストが空のときだけ false。置き換えは非同期に
 * なるので、整形中にユーザが編集して対象テキストが変わっていたら結果は捨てる
 * (古い整形結果で新しい入力を上書きしない)。
 */
function formatEditorContent(
  view: EditorView,
  driver: string,
  onError?: (message: string) => void,
): boolean {
  const startState = view.state;
  const sel = startState.selection.main;
  const isSelection = !sel.empty;
  const text = isSelection
    ? startState.sliceDoc(sel.from, sel.to)
    : startState.doc.toString();
  if (text.trim().length === 0) return false;
  void formatSqlAsync(text, driver).then(
    (formatted) => {
      if (formatted === text) return;
      const current = view.state;
      // 整形中に文書が変わった場合は適用しない。同じ範囲の中身が変わっていなければ
      // (別の場所だけが編集された場合も含め) 位置がずれていないかを文字列で確認する。
      if (isSelection) {
        if (current.sliceDoc(sel.from, sel.to) !== text) return;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: formatted },
          selection: { anchor: sel.from, head: sel.from + formatted.length },
        });
      } else {
        if (current.doc.length !== text.length || current.doc.toString() !== text) return;
        view.dispatch({
          changes: { from: 0, to: current.doc.length, insert: formatted },
        });
      }
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message);
    },
  );
  return true;
}

function selectionOrAllText(view: EditorView): string | null {
  const sel = view.state.selection.main;
  const text = sel.empty
    ? view.state.doc.toString()
    : view.state.sliceDoc(sel.from, sel.to);
  if (text.trim().length === 0) return null;
  return text;
}

/**
 * 影響行数プリフライト (#737) が対象にするテキスト。実行対象と同じく「選択があれば
 * 選択、無ければ全文」で、空/空白のみは空文字を返す (バッジを出さない)。`EditorState`
 * から直接読めるので updateListener からも呼べる。
 */
function preflightTextFromState(state: EditorState): string {
  const sel = state.selection.main;
  // 上限を超える巨大なテキストは、文字列化する前に(doc.toString() の O(n) を避けて)
  // 対象外にする (#1256)。
  const length = sel.empty ? state.doc.length : sel.to - sel.from;
  if (length > PREFLIGHT_MAX_CHARS) return "";
  const text = sel.empty ? state.doc.toString() : state.sliceDoc(sel.from, sel.to);
  return text.trim().length > 0 ? text : "";
}

/**
 * プリフライト対象テキストの更新をまとめる待ち時間 (ms)。打鍵ごとに全文を文字列化して
 * state を更新し計画を組み直すのをやめ、入力が止まってから 1 回だけ行う (#1256)。
 * 編集が止まってから COUNT までの合計が従来の約 500ms になるよう、`usePreflight.ts` の
 * COUNT 側デバウンスと合わせて決めている。
 */
const PREFLIGHT_TEXT_DEBOUNCE_MS = 150;

/**
 * 復元するカーソル/選択を doc 長へクランプする (#678)。SQL 本文と保存オフセットが
 * 不整合でも範囲外にならない。undefined なら CodeMirror 既定 (先頭) に任せるため null。
 */
function clampSelection(
  selection: { anchor: number; head: number } | undefined,
  docLength: number,
): { anchor: number; head: number } | null {
  if (!selection) return null;
  return {
    anchor: Math.max(0, Math.min(selection.anchor, docLength)),
    head: Math.max(0, Math.min(selection.head, docLength)),
  };
}

/** FK 一覧の内容キー。並び順に依存しないよう `table.column>参照先` をソートして連結する。 */
function fkContentKey(fks: ForeignKey[]): string {
  return fks
    .map((f) => `${f.table}.${f.column}>${f.referenced_table}.${f.referenced_column ?? ""}`.toLowerCase())
    .sort()
    .join(",");
}

/** 列の情報パネル (#1413) の見出し。呼び出し時点のロケールで解決する。 */
function columnInfoLabels(): ColumnInfoLabels {
  return {
    type: t("editorColInfoType"),
    nullable: t("editorColInfoNullable"),
    nullAllowed: t("editorColInfoNullAllowed"),
    notNull: t("editorColInfoNotNull"),
    primaryKey: t("editorColInfoPrimaryKey"),
    references: t("editorColInfoReferences"),
    defaultValue: t("editorColInfoDefault"),
  };
}

function buildSqlExtension(
  driver: string,
  schemaTable: SchemaTable | null | undefined,
  databaseSchema: TableSchema[] | null | undefined,
  defaultDatabase: string | null | undefined,
  getFks: () => ForeignKey[],
  getColumns: (table: string) => Promise<TableColumnInfo[]>,
) {
  // Collect every known table → columns mapping. The full-database overview is
  // the bulk of it; the active table is folded in too so its columns are
  // available immediately, before the (async) overview fetch resolves.
  const tableColumns: Record<string, string[]> = {};
  if (databaseSchema) {
    for (const tbl of databaseSchema) {
      if (tbl.columns.length > 0) tableColumns[tbl.name] = tbl.columns;
    }
  }
  if (
    schemaTable &&
    schemaTable.columns.length > 0 &&
    !tableColumns[schemaTable.name]
  ) {
    tableColumns[schemaTable.name] = schemaTable.columns;
  }

  let schema: SQLNamespace | undefined;
  let defaultTable: string | undefined;
  let defaultSchema: string | undefined;
  if (Object.keys(tableColumns).length > 0) {
    // Expose each table both bare (`table` / `table.column`) and namespaced
    // under its database (`db.table.column`), mirroring CodeMirror's expected
    // SQLNamespace shape. SQLite has no real database qualifier, so the bare
    // form alone is enough there.
    const namespaceDb = schemaTable?.database ?? defaultDatabase ?? undefined;
    // 種別 (table / column / fk) と列の情報パネル (#1413) を付けた名前空間を作る。
    // 情報パネルの中身は選択時に `describe_table` (キャッシュ済み) から遅延取得する。
    const dialectSpec = codeMirrorSqlDialectFor(driver).spec;
    schema = buildSchemaNamespace({
      tables: tableColumns,
      namespaceDb: namespaceDb && driver !== "sqlite" ? namespaceDb : null,
      idQuote: dialectSpec.identifierQuotes?.[0] ?? '"',
      idCaseInsensitive: !!dialectSpec.caseInsensitiveIdentifiers,
      fks: getFks(),
      columnInfo: (table, column) => async () => {
        try {
          const meta = findColumnInfo(await getColumns(table), column);
          return meta ? renderColumnInfo(describeColumn(meta, columnInfoLabels())) : null;
        } catch {
          // 情報パネルは best-effort。取得できなければパネルを出さない。
          return null;
        }
      },
    });
    // Prefer the active table for unqualified column completion; otherwise the
    // dialect still completes once the user qualifies with a table name.
    defaultTable = schemaTable?.name;
    defaultSchema = namespaceDb;
  }
  // FK から `JOIN other ON ...` を提案する補完ソース (#1356)。言語データとして
  // 足すので、lang-sql 標準のスキーマ補完と併存する。
  const joinSource = (ctx: CompletionContext): CompletionResult | null => {
    // CodeMirror は補完ソースの同期例外で補完全体が止まるため、握りつぶして null を返す。
    try {
      const r = joinCompletions({
        driver,
        text: ctx.state.sliceDoc(0, ctx.pos),
        fks: getFks(),
      });
      if (!r) return null;
      return {
        from: r.from,
        options: r.options.map((o) => ({ ...o, type: "keyword", boost: 99 })),
      };
    } catch {
      return null;
    }
  };
  // WITH の CTE 名・その列、派生表の別名・その列、SELECT の別名を補完する (#1419)。
  // JOIN 補完と同じく languageData に並べ、lang-sql の標準補完と併存させる。
  const derivedSource = (ctx: CompletionContext): CompletionResult | null => {
    // 同期例外は補完全体を止めるため、握りつぶして null を返す (joinSource と同じ理由)。
    try {
      const r = derivedCompletions({
        driver,
        text: ctx.state.doc.toString(),
        pos: ctx.pos,
      });
      if (!r) return null;
      // 候補の種別は純モジュールから受け、表示語はここで現在のロケールに変換する。
      const kindLabel = {
        cte: t("editorCompletionCte"),
        derived: t("editorCompletionDerived"),
        alias: t("editorCompletionAlias"),
      } as const;
      return {
        from: r.from,
        options: r.options.map(({ kind, ...o }) => ({
          ...o,
          detail: kindLabel[kind],
          boost: 90,
        })),
      };
    } catch {
      return null;
    }
  };
  return [
    sql({
      dialect: codeMirrorSqlDialectFor(driver),
      schema,
      defaultTable,
      defaultSchema,
      upperCaseKeywords: true,
      keywordCompletion: keywordCompletionOption,
    }),
    EditorState.languageData.of(() => [
      { autocomplete: joinSource },
      { autocomplete: derivedSource },
    ]),
  ];
}

export const QueryEditor = memo(forwardRef<QueryEditorHandle, Props>(function QueryEditor({
  onRun,
  onRunInNewTab,
  runNewTabCombo,
  running,
  previewRunning,
  onPreview,
  onExplain,
  onBroadcast,
  broadcastAvailable,
  onChange,
  onDocChange,
  onFormatError,
  onSaveSnippet,
  onOpenFile,
  onSaveFile,
  disabled,
  schemaTable,
  databaseSchema,
  activeTable,
  tabId,
  initialSql,
  initialSelection,
  onSelectionChange,
  sessionId,
  defaultDatabase,
  explainMode,
  driver = "mysql",
  builderSnapshot,
  onBuilderPersist,
  readOnly,
  isProduction,
  onOpenSqlInNewTab,
  emergencyMode,
  onToggleEmergencyMode,
  queryHistory,
  editorBindings,
  focusMode,
  onToggleFocus,
  onPreflightImpact,
  onAiSqlAction,
}: Props, ref) {
  const t = useT();
  const settings = useSettings();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sqlCompartment = useMemo(() => new Compartment(), []);
  const actionKeymapCompartment = useMemo(() => new Compartment(), []);
  const lintCompartment = useMemo(() => new Compartment(), []);

  // リアルタイム構文チェック (#704)。設定でオン/オフでき、診断メッセージは i18n
  // 経由で日英対応。linter は `syntaxTree(state)` の (lang-sql が既に構築した)
  // ツリーを再利用するため方言追従は自動 (別途 dialect を渡す必要がない)。
  const sqlLintEnabled = settings.sqlLintEnabled;
  const lintMessages: SqlLintMessages = {
    syntaxError: t("editorLintSyntaxError"),
    unterminated: t("editorLintUnterminated"),
    unknownStatementStart: t("editorLintUnknownStatement"),
    unterminatedComment: t("editorLintUnterminatedComment"),
    clauseOrder: t("editorLintClauseOrder"),
    keywordTypo: t("editorLintKeywordTypo"),
    missingOperand: t("editorLintMissingOperand"),
    extraComma: t("editorLintExtraComma"),
    missingBy: t("editorLintMissingBy"),
    incompleteStatement: t("editorLintIncomplete"),
  };
  const lintMessagesRef = useRef(lintMessages);
  lintMessagesRef.current = lintMessages;
  const sqlLintEnabledRef = useRef(sqlLintEnabled);
  sqlLintEnabledRef.current = sqlLintEnabled;

  // オンのときだけ linter + lintGutter を返し、オフでは空 (診断を一切出さない)。
  // クロージャは ref からメッセージを読むので、言語切替時は下の useEffect が
  // compartment を作り直して再 lint する。「文が途中で終わっている」判定はカーソルが
  // 文の末尾にある間 (= 入力中) は出さないので、カーソル移動でも再 lint する。
  const buildLintExtension = (enabled: boolean) =>
    enabled
      ? [
          lintGutter(),
          linter(
            (view) =>
              diagnosticsFromTree(
                syntaxTree(view.state),
                view.state.doc.toString(),
                lintMessagesRef.current,
                { cursor: view.state.selection.main.head },
              ),
            { delay: SQL_LINT_DELAY_MS, needsRefresh: (u) => u.selectionSet },
          ),
        ]
      : [];

  // エディタ系ショートカットの解決済みコンボ。未指定は既定へフォールバック。
  const runCombo = editorBindings?.run ?? DEFAULT_SHORTCUT_COMBOS.run;
  const runStatementCombo = editorBindings?.runStatement ?? DEFAULT_SHORTCUT_COMBOS.runStatement;
  const previewCombo = editorBindings?.preview ?? DEFAULT_SHORTCUT_COMBOS.preview;
  const formatCombo = editorBindings?.format ?? DEFAULT_SHORTCUT_COMBOS.format;
  const explainCombo = editorBindings?.explain ?? DEFAULT_SHORTCUT_COMBOS.explain;
  const bindingsRef = useRef<EditorKeyBindings>({
    run: runCombo,
    runStatement: runStatementCombo,
    preview: previewCombo,
    format: formatCombo,
    explain: explainCombo,
  });
  bindingsRef.current = {
    run: runCombo,
    runStatement: runStatementCombo,
    preview: previewCombo,
    format: formatCombo,
    explain: explainCombo,
  };
  // いま props が求めている compartment 設定 (補完・構文チェック・アクションキーマップ)。
  // view / state 側に入っている設定 (`appliedConfigRef`) と食い違ったときだけ
  // reconfigure する (#1308: 初回マウントやタブ切替で無駄に作り直さない)。
  // 届いた FK の内容キー (`fkContentKey`) は ref に持ち、内容が変わったときだけ小さな版数
  // (state) を進める。補完 (外部キー列の種別) は版数が変わったときだけ作り直すので、同じ
  // 内容が届き直しても再構成しないし、キーの文字列を毎レンダー比較することもない。
  const fkKeyRef = useRef("");
  const [fkRev, setFkRev] = useState(0);
  const schemaKey = `${
    schemaTable
      ? `${schemaTable.database}.${schemaTable.name}|${schemaTable.columns.join(",")}`
      : ""
  }|fk:${fkRev}`;
  const desiredConfig: AppliedEditorConfig = {
    driver,
    schemaKey,
    databaseSchema: databaseSchema ?? null,
    defaultDatabase: defaultDatabase ?? null,
    lint: [
      sqlLintEnabled ? "1" : "0",
      lintMessages.syntaxError,
      lintMessages.unterminated,
      lintMessages.unknownStatementStart,
      lintMessages.unterminatedComment,
      lintMessages.clauseOrder,
      lintMessages.keywordTypo,
      lintMessages.missingOperand,
      lintMessages.extraComma,
      lintMessages.missingBy,
      lintMessages.incompleteStatement,
    ].join("\u0000"),
    keymap: [runCombo, runStatementCombo, previewCombo, formatCombo, explainCombo].join("\u0000"),
  };
  const desiredConfigRef = useRef(desiredConfig);
  desiredConfigRef.current = desiredConfig;
  // 補完拡張の組み立てに使う最新の入力。タブ切替で新規 state を作るときに、マウント時点の
  // 古い値ではなく現在の値を使うため ref 越しに読む。
  const sqlArgsRef = useRef({ driver, schemaTable, databaseSchema, defaultDatabase });
  sqlArgsRef.current = { driver, schemaTable, databaseSchema, defaultDatabase };
  // JOIN 補完 (#1356) 用の FK 一覧。DB 単位で取得 (バックエンドがキャッシュ済み) し、
  // 補完ソースは ref 越しに読む。DDL でスキーマキャッシュが更新されたら取り直す。
  const fksRef = useRef<ForeignKey[]>([]);
  // 列の情報パネル (#1413) 用の `describe_table` キャッシュ。スキーマ更新で捨てる。
  const columnCacheRef = useRef(new Map<string, Promise<TableColumnInfo[]>>());
  const fkDatabase = schemaTable?.database ?? defaultDatabase ?? null;
  const loadColumnsRef = useRef<(table: string) => Promise<TableColumnInfo[]>>(() =>
    Promise.reject(new Error("no session")),
  );
  loadColumnsRef.current = (table) => {
    if (!sessionId || !fkDatabase) return Promise.reject(new Error("no session"));
    const key = `${fkDatabase}\u0000${table}`;
    const cached = columnCacheRef.current.get(key);
    if (cached !== undefined) return cached;
    const p = api.describeTable(sessionId, fkDatabase, table);
    columnCacheRef.current.set(key, p);
    // 失敗はキャッシュしない (次の選択で再試行)。スキーマ更新で Map が差し替わっていたら
    // 新しい Map の同じキーを消さないよう、作成時の Map を保持して照合する。
    const cache = columnCacheRef.current;
    p.catch(() => {
      if (cache.get(key) === p) cache.delete(key);
    });
    return p;
  };
  const getColumns = (table: string) => loadColumnsRef.current(table);
  const fkScopeRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: databaseSchema は DDL 後の再取得トリガー
  useEffect(() => {
    columnCacheRef.current = new Map();
    // FK は同じ session / DB での取り直し (DDL 後など) では空にしない。空にすると同じコミットの
    // 補完再構成が FK 無しで走り、同じ FK が返っても内容キーが変わらず作り直されない。
    // session / DB が変わったときだけ FK を捨てる。
    const scope = `${sessionId ?? ""}\u0000${fkDatabase ?? ""}`;
    if (fkScopeRef.current !== scope) {
      fkScopeRef.current = scope;
      fksRef.current = [];
      if (fkKeyRef.current !== "") {
        fkKeyRef.current = "";
        setFkRev((n) => n + 1);
      }
    }
    if (!sessionId || !fkDatabase) return;
    let cancelled = false;
    api
      .foreignKeys(sessionId, fkDatabase)
      .then((r) => {
        if (cancelled) return;
        fksRef.current = r;
        const key = fkContentKey(r);
        if (key !== fkKeyRef.current) {
          fkKeyRef.current = key;
          setFkRev((n) => n + 1);
        }
      })
      .catch(() => { /* 補完は best-effort */ });
    return () => {
      cancelled = true;
    };
  }, [sessionId, fkDatabase, databaseSchema]);
  // 現在アクティブな state の compartment に入っている設定。
  const appliedConfigRef = useRef<AppliedEditorConfig>(desiredConfig);
  // タブ別 state の保存先と、新規 state の作成関数 (マウント時に一度だけ組み立てる)。
  const stateCacheRef = useRef<EditorStateCache | null>(null);
  if (stateCacheRef.current === null) stateCacheRef.current = new EditorStateCache();
  const createStateRef = useRef<
    ((doc: string, selection: { anchor: number; head: number } | null) => EditorState) | null
  >(null);
  const activeTabIdRef = useRef(tabId);
  const [hasContent, setHasContent] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const [showAiQuery, setShowAiQuery] = useState(false);
  const aiAvailable = useAiAvailable();
  // エディタはタブ間で再利用されるので、タブ / セッション / EXPLAIN 化が変わったら閉じる
  // (条件が戻ったときにモーダルが勝手に再表示されないように)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 値の変化をトリガーにするだけ
  useEffect(() => {
    setShowAiQuery(false);
  }, [tabId, sessionId, explainMode]);
  // 「…」オーバーフローメニュー (#915) のアンカー (ビューポート座標)。開いている
  // 間だけ非 null。位置決め・外側クリック/Escape での閉じ・キーボード操作は共有の
  // `ContextMenu` に任せる。
  const [overflowAnchor, setOverflowAnchor] = useState<{ x: number; y: number } | null>(null);
  // エディタ本文の右クリックメニュー (#1113)。開いた瞬間の選択状態で項目を決める
  // (メニュー表示中に選択は変わらない) ため、アンカーと一緒に文脈も保持する。
  const [editorMenu, setEditorMenu] = useState<
    { x: number; y: number; hasSelection: boolean; hasContent: boolean } | null
  >(null);
  // 影響行数プリフライト (#737) の対象テキスト。updateListener が「選択 or 全文」を
  // 反映し、値が実際に変わったときだけ更新する (カーソル移動だけでは再計算しない)。
  const [preflightSql, setPreflightSql] = useState("");
  const preflightSqlRef = useRef("");
  // プリフライト対象テキスト更新のデバウンスタイマー (#1256)。
  const preflightTimerRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const onFormatErrorRef = useRef(onFormatError);
  onFormatErrorRef.current = onFormatError;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const onExplainRef = useRef(onExplain);
  onExplainRef.current = onExplain;
  const onPreflightImpactRef = useRef(onPreflightImpact);
  onPreflightImpactRef.current = onPreflightImpact;
  const onAiSqlActionRef = useRef(onAiSqlAction);
  onAiSqlActionRef.current = onAiSqlAction;
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;
  const driverRef = useRef(driver);
  driverRef.current = driver;
  // 履歴ナビゲーション用。エディタは初回だけ生成されキーマップ内のクロージャ
  // から ref を読むため、props の履歴はレンダのたびに ref へ流し込む。
  const historyRef = useRef<string[]>(queryHistory ?? []);
  historyRef.current = queryHistory ?? [];
  const navStateRef = useRef<HistoryNavState>(initialHistoryNav);
  // 履歴ナビゲーションによる doc 書き換え中は true。updateListener がこのフラグを見て、
  // ユーザのタイプ由来の変更とプログラム由来の変更を区別し、前者でだけ位置をリセット
  // する (タイプし始めたら bash 同様に履歴位置から離脱する)。
  const navigatingRef = useRef(false);

  // 実行・編集を機にナビゲーション位置を初期化する。実行後に ↑ を押したら最新から
  // たどり直せるようにする (bash の挙動に準拠)。
  const resetHistoryNav = () => {
    navStateRef.current = initialHistoryNav;
  };

  // 走った文を一瞬ハイライトし、少し後にクリアする (#555)。view が破棄済みでも
  // 落ちないよう dispatch は防御的に包む。
  const flashStatement = (view: EditorView, from: number, to: number) => {
    view.dispatch({ effects: stmtFlashEffect.of({ from, to }) });
    window.setTimeout(() => {
      const v = viewRef.current;
      if (!v) return;
      try {
        v.dispatch({ effects: stmtFlashEffect.of(null) });
      } catch {
        // view が破棄済みなら無視。
      }
    }, 650);
  };

  // 「カーソル位置の文だけ実行」(#555)。選択があれば従来どおり選択を優先し、
  // 無ければ `;` 区切りでカーソルが乗る単一文を検出して実行、その範囲をハイライト。
  const runStatementUnderCursor = (view: EditorView): boolean => {
    const sel = view.state.selection.main;
    if (!sel.empty) {
      const text = view.state.sliceDoc(sel.from, sel.to);
      if (text.trim().length === 0) return true;
      resetHistoryNav();
      onRunRef.current(text);
      flashStatement(view, sel.from, sel.to);
      return true;
    }
    // driverRef 経由 (keymap は Compartment に一度だけ構築されるため、直接
    // `driver` を読むとリコンフィグ前は接続切替前のドライバのまま固定される —
    // 同じ理由で下の format アクションも driverRef.current を使っている)。
    // 文分割の解釈 (バックスラッシュエスケープ、#852/#1004) を実行ゲート
    // (`App.tsx` の `analyzeDangerousSql`/`isReadOnlySql`) と揃える。
    const range = statementAtOffset(view.state.doc.toString(), sel.head, driverRef.current);
    if (!range) return true;
    resetHistoryNav();
    onRunRef.current(range.text);
    flashStatement(view, range.from, range.to);
    return true;
  };

  // 再割り当て可能なエディタアクション (#557) のキーマップを、解決済みコンボから
  // 組み立てる。Compartment 経由で初回構築と変更時の再構成の両方に使う。
  const buildActionKeymap = (bindings: EditorKeyBindings) => [
    {
      key: comboToCodeMirror(bindings.run),
      run: (v: EditorView) => {
        const text = selectionOrAllText(v);
        if (text !== null) {
          resetHistoryNav();
          onRunRef.current(text);
        }
        return true;
      },
    },
    {
      key: comboToCodeMirror(bindings.runStatement),
      run: runStatementUnderCursor,
    },
    {
      key: comboToCodeMirror(bindings.preview),
      run: (v: EditorView) => {
        const preview = onPreviewRef.current;
        if (!preview) return false;
        const text = selectionOrAllText(v);
        if (text !== null) preview(text);
        return true;
      },
    },
    {
      key: comboToCodeMirror(bindings.format),
      preventDefault: true,
      run: (v: EditorView) => formatEditorContent(v, driverRef.current, onFormatErrorRef.current),
    },
    {
      // EXPLAIN (#1113)。EXPLAIN タブ (onExplain 無し) では素通しする。
      key: comboToCodeMirror(bindings.explain),
      preventDefault: true,
      run: (v: EditorView) => {
        const explain = onExplainRef.current;
        if (!explain) return false;
        const text = selectionOrAllText(v);
        if (text !== null) explain(text);
        return true;
      },
    },
  ];

  // biome-ignore lint/correctness/useExhaustiveDependencies: EditorView はマウント時に一度だけ作る。initialSql / initialSelection と各種 build* は初期 state の構築にだけ使い、最新値は ref 経由で読む。依存に入れると編集内容が失われるため空配列にしている
  useEffect(() => {
    if (!hostRef.current) return;
    const startDoc = initialSql ?? "";

    // 履歴ナビゲーションの結果をエディタへ反映する。`navigatingRef` を立てて dispatch
    // することで、この doc 変更を updateListener がユーザのタイプと誤認してナビ位置を
    // リセットしないようにする (dispatch は同期で updateListener を呼ぶ)。
    const applyHistoryNav = (
      view: EditorView,
      result: ReturnType<typeof navigateOlder>,
    ): boolean => {
      if (!result) return false;
      navStateRef.current = result.state;
      navigatingRef.current = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: result.text },
          selection: { anchor: result.cursor === "start" ? 0 : result.text.length },
          scrollIntoView: true,
        });
      } finally {
        navigatingRef.current = false;
      }
      return true;
    };

    // タブごとの state を作る (#1308)。初回マウントと、保存済み state の無いタブへの
    // 切替の両方で使う。拡張はすべて ref / compartment 越しに props を読むので、
    // どのタブの state にも同じものを載せてよい。
    const makeState = (
      doc: string,
      selection: { anchor: number; head: number } | null,
    ): EditorState =>
      EditorState.create({
        doc,
        ...(selection ? { selection } : {}),
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          syntaxHighlighting(noobDBHighlightStyle, { fallback: true }),
          // 種別アイコンは CodeMirror 既定のグリフではなく共通 `Icon` で描く (#1413)。
          // `icons: false` で既定を止め、同じ位置 (20) に自前のアイコンを差す。
          autocompletion({
            icons: false,
            addToOptions: [{ render: (c) => renderCompletionIcon(c.type), position: 20 }],
          }),
          // エディタ内検索・置換。検索パネルはエディタ上部に出し、選択語の
          // 同一語ハイライトも有効化する。キーバインドは下の keymap に searchKeymap
          // を含める (Mod-f はエディタにフォーカスがあるときだけ起動し、結果横断検索
          // の Cmd/Ctrl+F とはフォーカス文脈で住み分ける — App 側でガード)。
          search({ top: true }),
          highlightSelectionMatches(),
          stmtFlashField,
          // スキーマツリー行のドラッグ挿入 (#1414) の着地点マーカー。
          treeDropMarkerField,
          // 構文チェック (#704) は Compartment 越しにして、設定トグルや言語切替で
          // 再構成できるようにする。作成時点の設定値で初期化する。
          lintCompartment.of(buildLintExtension(sqlLintEnabledRef.current)),
          sqlCompartment.of(
            buildSqlExtension(
              sqlArgsRef.current.driver,
              sqlArgsRef.current.schemaTable,
              sqlArgsRef.current.databaseSchema,
              sqlArgsRef.current.defaultDatabase,
              () => fksRef.current,
              getColumns,
            ),
          ),
          // 再割り当て可能なアクション (Run / Run statement / Preview / Format) は
          // Compartment 越しのキーマップにして、設定変更時に再構成できるようにする。
          // 静的キーマップより前に置き優先させる。
          actionKeymapCompartment.of(keymap.of(buildActionKeymap(bindingsRef.current))),
          keymap.of([
            { key: "Tab", run: acceptCompletion },
            // ↑ / ↓ による実行済みクエリの履歴ナビゲーション。1 行目での ↑ /
            // 末尾行での ↓ のときだけ起動し、それ以外は false を返して通常のカーソル
            // 移動へ委ねる。補完ポップアップ表示中はその選択移動を優先する。
            {
              key: "ArrowUp",
              run: (v) => {
                if (completionStatus(v.state) === "active") return false;
                const sel = v.state.selection.main;
                if (!sel.empty) return false;
                if (v.state.doc.lineAt(sel.head).number !== 1) return false;
                return applyHistoryNav(
                  v,
                  navigateOlder(historyRef.current, v.state.doc.toString(), navStateRef.current),
                );
              },
            },
            {
              key: "ArrowDown",
              run: (v) => {
                if (completionStatus(v.state) === "active") return false;
                const sel = v.state.selection.main;
                if (!sel.empty) return false;
                if (v.state.doc.lineAt(sel.head).number !== v.state.doc.lines) return false;
                return applyHistoryNav(v, navigateNewer(historyRef.current, navStateRef.current));
              },
            },
            ...searchKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...closeBracketsKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              // ユーザのタイプ由来の変更なら履歴ナビ位置を離脱する (履歴ナビによる
              // 書き換えは `navigatingRef` で除外)。bash で履歴呼び出し後に編集すると
              // その行が現在行になるのと同じ挙動。
              if (!navigatingRef.current) resetHistoryNav();
              setHasContent(u.state.doc.length > 0);
              onDocChangeRef.current?.(u.state.doc);
              // 全文の文字列化は、文字列を求める呼び出し側があるときだけ (#1316)。
              const onChangeText = onChangeRef.current;
              if (onChangeText) onChangeText(u.state.doc.toString());
            }
            // カーソル/選択の変化をタブ永続化用に通知 (#678)。ref マップ書き込みだけの
            // 軽量コールバックなので毎回発火してよい (React 再レンダは起こさない)。
            if (u.selectionSet || u.docChanged) {
              const sel = u.state.selection.main;
              onSelectionChangeRef.current?.({ anchor: sel.anchor, head: sel.head });
              // プリフライト対象テキスト (選択 or 全文) の更新は、打鍵ごとではなく入力が
              // 止まってから 1 回だけ行う (全文の文字列化・state 更新・計画組み立てを
              // 打鍵ごとに走らせない、#1256)。タイマー発火時に最新の state を読む。
              if (preflightTimerRef.current !== null) window.clearTimeout(preflightTimerRef.current);
              preflightTimerRef.current = window.setTimeout(() => {
                preflightTimerRef.current = null;
                const current = viewRef.current;
                if (!current) return;
                const pfText = preflightTextFromState(current.state);
                // 実値が変わったときだけ setState する。
                if (pfText !== preflightSqlRef.current) {
                  preflightSqlRef.current = pfText;
                  setPreflightSql(pfText);
                }
              }, PREFLIGHT_TEXT_DEBOUNCE_MS);
            }
          }),
        ],
      });
    createStateRef.current = makeState;
    const view = new EditorView({
      parent: hostRef.current,
      state: makeState(startDoc, clampSelection(initialSelection, startDoc.length)),
    });
    viewRef.current = view;
    // スキーマツリー行のドラッグ挿入のドロップ先 (#1414)。ポインタ位置 → キャレット位置は
    // `posAtCoords` で決める。文書の外 (行番号ガター・余白) は最寄りの位置に寄せる (precise=false)。
    const unregisterTreeDrop = registerTreeDropTarget({
      element: view.dom,
      posAtCoords: (x, y) => view.posAtCoords({ x, y }, false),
      setMarker: (pos) => view.dispatch({ effects: treeDropMarkerEffect.of(pos) }),
      insert: (item, pos, qualified) => {
        const text = treeItemInsertText(driverRef.current, item, qualified);
        const at = pos ?? view.state.doc.length;
        view.dispatch({
          changes: { from: at, insert: text },
          selection: { anchor: at + text.length },
          userEvent: "input.drop",
        });
        view.focus();
      },
    });
    appliedConfigRef.current = desiredConfigRef.current;
    setHasContent(startDoc.length > 0);
    // 復元されたタブが書き込み DML なら、マウント直後からプリフライトを効かせる。
    const initPreflightText = preflightTextFromState(view.state);
    preflightSqlRef.current = initPreflightText;
    setPreflightSql(initPreflightText);
    return () => {
      unregisterTreeDrop();
      if (preflightTimerRef.current !== null) {
        window.clearTimeout(preflightTimerRef.current);
        preflightTimerRef.current = null;
      }
      view.destroy();
    };
  }, []);

  // タブ切替 (#1308)。`EditorView` は作り直さず、離れるタブの state を保存して、戻る
  // タブの保存済み state (無ければ `initialSql` から新規) を `setState` で差し替える。
  // `setState` は update listener を呼ばないので、onChange / onSelectionChange の
  // 誤発火 (別タブの内容を現在のタブへ書き戻す) は起きない。描画前に差し替えて、前のタブの
  // 本文が 1 フレーム見えないよう layout effect にする。
  // biome-ignore lint/correctness/useExhaustiveDependencies: タブ切替 (tabId の変化) のときだけ実行する。initialSql / initialSelection は切替後のタブ本文として読むだけで、props の変化では EditorView の state を差し替えない (#1308)
  useLayoutEffect(() => {
    const view = viewRef.current;
    const prevTabId = activeTabIdRef.current;
    if (!view || tabId === undefined || prevTabId === tabId) {
      activeTabIdRef.current = tabId;
      return;
    }
    activeTabIdRef.current = tabId;
    const cache = stateCacheRef.current;
    const makeState = createStateRef.current;
    if (!cache || !makeState) return;

    if (prevTabId !== undefined) {
      cache.set(prevTabId, {
        state: view.state,
        applied: appliedConfigRef.current,
        scrollTop: view.scrollDOM.scrollTop,
        hostScrollTop: hostRef.current?.scrollTop ?? 0,
      });
    }
    if (preflightTimerRef.current !== null) {
      window.clearTimeout(preflightTimerRef.current);
      preflightTimerRef.current = null;
    }
    resetHistoryNav();

    const doc = initialSql ?? "";
    const hit = cache.take(tabId);
    // 保存した本文が App 側のタブ本文と食い違うときは (外部から書き換えられた等) 保存分を
    // 捨てて作り直す。長さを先に比べて、通常は全文の文字列化を避ける。
    const reusable =
      hit && hit.state.doc.length === doc.length && hit.state.doc.toString() === doc ? hit : null;
    if (reusable) {
      view.setState(reusable.state);
      appliedConfigRef.current = reusable.applied;
      view.scrollDOM.scrollTop = reusable.scrollTop;
      if (hostRef.current) hostRef.current.scrollTop = reusable.hostScrollTop;
    } else {
      view.setState(makeState(doc, clampSelection(initialSelection, doc.length)));
      appliedConfigRef.current = desiredConfigRef.current;
      view.scrollDOM.scrollTop = 0;
      if (hostRef.current) hostRef.current.scrollTop = 0;
    }
    setHasContent(view.state.doc.length > 0);
    // Query Builder は切替で閉じる (従来の挙動を維持。入力は builderSnapshot で復元される)。
    setShowBuilder(false);
    const pfText = preflightTextFromState(view.state);
    preflightSqlRef.current = pfText;
    setPreflightSql(pfText);
  }, [tabId]);

  // compartment の設定が実際に変わったときだけ reconfigure する (#1308)。初回マウントや、
  // 設定が同じタブ同士の切替では何もしない。以前は補完・構文チェック・キーマップの
  // 3 つをマウントのたびに作り直していた。
  //   - 補完: 接続のスキーマ / 方言 / 既定 DB が変わったとき。保存済み state が古い
  //     スキーマで作られていた場合もここで追従する。
  //   - 構文チェック: オン/オフ、または診断メッセージ (言語切替) が変わったとき。
  //   - キーマップ: ショートカットの上書きが変わったとき (#557)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 設定の最新値は desiredConfigRef / appliedConfigRef (ref) から読み、実際の差分判定は本体で行う。依存の desiredConfig.* と tabId は再判定のトリガー。Compartment・build*Extension・driver 等を依存に入れると毎レンダーで走るため除外する
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const applied = appliedConfigRef.current;
    const want = desiredConfigRef.current;
    const sqlChanged = sqlConfigChanged(applied, want);
    const lintChanged = applied.lint !== want.lint;
    const keymapChanged = applied.keymap !== want.keymap;
    if (!sqlChanged && !lintChanged && !keymapChanged) return;
    const effects: StateEffect<unknown>[] = [];
    if (sqlChanged) {
      effects.push(
        sqlCompartment.reconfigure(
          buildSqlExtension(driver, schemaTable, databaseSchema, defaultDatabase, () => fksRef.current, getColumns),
        ),
      );
    }
    if (lintChanged) effects.push(lintCompartment.reconfigure(buildLintExtension(sqlLintEnabled)));
    if (keymapChanged) {
      effects.push(
        actionKeymapCompartment.reconfigure(keymap.of(buildActionKeymap(bindingsRef.current))),
      );
    }
    appliedConfigRef.current = want;
    view.dispatch({ effects });
    // 方言 (driver) が変わっても `@codemirror/lint` は doc 変更が無い限り再実行
    // されず、旧方言の診断が残ってしまう (#704 のレビュー指摘)。lint 有効時は
    // 明示的に再 lint を促し、新方言のパースツリーで診断を更新する。
    if (sqlChanged && sqlLintEnabledRef.current) forceLinting(view);
    // `databaseSchema` is a stable reference from the parent's cache: it only
    // changes identity on (re)fetch or when the editor's database changes, so
    // depending on it directly is both correct and cheap.
  }, [
    tabId,
    desiredConfig.schemaKey,
    desiredConfig.driver,
    desiredConfig.databaseSchema,
    desiredConfig.defaultDatabase,
    desiredConfig.lint,
    desiredConfig.keymap,
  ]);

  // 影響行数プリフライト (#737)。現在文が単純な UPDATE / DELETE のとき、対象と
  // WHERE から COUNT を組み立ててデバウンス付きで裏実行する。設定オフ・未接続では
  // 無効 (フックが即 null を返しバッジは出ない)。read_only セッションでも COUNT は
  // 読み取りなので安全に動く。
  const preflight = usePreflightImpact({
    sql: preflightSql || null,
    sessionId: sessionId ?? null,
    database: defaultDatabase ?? null,
    enabled: settings.preflightImpactEnabled && !disabled,
    driver,
  });
  // 結果が変わるたび親へ通知 (危険クエリ確認ダイアログへの件数引き継ぎ用)。
  // タブ切替直後に結果が変わらない (同じ SQL) 場合も、新しいタブのコールバックへ
  // 通知し直す (#1308)。
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabId はタブ切替直後に結果が変わらない場合も新しいタブのコールバックへ通知し直すためのトリガーとして意図的に依存へ含めている (#1308)
  useEffect(() => {
    onPreflightImpactRef.current?.(preflight);
  }, [preflight, tabId]);

  // カーソル位置 (選択があれば選択を置換) へテキストを挿入する共通処理。
  // `QueryEditorHandle.insertText` (親からの外部呼び出し) と、Query Builder の
  // 「エディタに挿入」(`onInsertToEditor`、本コンポーネント内で完結する呼び出し)
  // の両方が使う — 挿入先はどちらも同じエディタなので経路を分けない。
  const insertAtCursor = (text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    view.focus();
  };

  // 選択範囲 (無ければ全文) の SQL を AI の解説 / 最適化案へ渡す (#695)。ref だけを読むので、
  // 初回だけ構築するハンドルから呼んでも古いクロージャにならない。
  const requestAiSql = (kind: SqlAssistKind) => {
    const view = viewRef.current;
    const cb = onAiSqlActionRef.current;
    const id = tabIdRef.current;
    if (!view || !cb || !id) return;
    const sel = view.state.selection.main;
    const range = sel.empty ? null : { from: sel.from, to: sel.to };
    const sqlText = range ? view.state.sliceDoc(range.from, range.to) : view.state.doc.toString();
    if (sqlText.trim() === "") return;
    cb({ kind, sql: sqlText, range, tabId: id });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: ハンドラは初回だけ構築する設計 (上のコメント参照)。insertAtCursor / resetHistoryNav / runStatementUnderCursor は毎レンダーで作り直されるが ref だけを読むため、古いクロージャでも最新の状態を参照できる
  useImperativeHandle(ref, () => ({
    insertText: insertAtCursor,
    setText: (text: string) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
      });
      view.focus();
    },
    getText: () => viewRef.current?.state.doc.toString() ?? "",
    replaceRange: (from: number, to: number, text: string) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true,
      });
      view.focus();
    },
    focus: () => {
      viewRef.current?.focus();
    },
    // 以下はパレットから呼ばれる。ハンドラは ref 経由で最新の props を読む
    // (useImperativeHandle は初回だけ構築するため)。
    runAll: () => {
      const view = viewRef.current;
      if (!view) return;
      const text = selectionOrAllText(view);
      if (text === null) return;
      resetHistoryNav();
      onRunRef.current(text);
    },
    runStatement: () => {
      const view = viewRef.current;
      if (view) runStatementUnderCursor(view);
    },
    formatSql: () => {
      const view = viewRef.current;
      if (view) formatEditorContent(view, driverRef.current, onFormatErrorRef.current);
    },
    explain: () => {
      const view = viewRef.current;
      const explain = onExplainRef.current;
      if (!view || !explain) return;
      const text = selectionOrAllText(view);
      if (text !== null) explain(text);
    },
    openAiQuery: () => setShowAiQuery(true),
    requestAiSql,
  }), []);

  const currentText = (): string | null => {
    const view = viewRef.current;
    if (!view) return null;
    return selectionOrAllText(view);
  };

  const saveSelectionOrAll = () => {
    if (!onSaveSnippet) return;
    const text = currentText();
    if (text !== null) onSaveSnippet(text);
  };

  const runSelectionOrAll = () => {
    const text = currentText();
    if (text !== null) {
      resetHistoryNav();
      onRun(text);
    }
  };

  const runInNewTabSelectionOrAll = () => {
    if (!onRunInNewTab) return;
    const text = currentText();
    if (text !== null) {
      resetHistoryNav();
      onRunInNewTab(text);
    }
  };

  const formatSelectionOrAll = () => {
    const view = viewRef.current;
    if (!view) return;
    formatEditorContent(view, driver, onFormatErrorRef.current);
  };

  const previewSelectionOrAll = () => {
    if (!onPreview) return;
    const text = currentText();
    if (text !== null) onPreview(text);
  };

  const explainSelectionOrAll = () => {
    if (!onExplain) return;
    const text = currentText();
    if (text !== null) onExplain(text);
  };

  const broadcastSelectionOrAll = () => {
    if (!onBroadcast) return;
    const text = currentText();
    if (text !== null) onBroadcast(text);
  };

  // 右クリックメニュー (#1113) の各アクション。実行系はツールバー / ショートカットと
  // 同じ関数を呼ぶだけで、新しい実行経路は作らない。
  const runEditorMenuAction = (action: SqlEditorMenuAction) => {
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    const selected = sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to);
    switch (action) {
      case "run":
        runSelectionOrAll();
        break;
      case "runStatement":
        runStatementUnderCursor(view);
        break;
      case "preview":
        previewSelectionOrAll();
        break;
      case "explain":
        explainSelectionOrAll();
        break;
      case "aiExplain":
      case "aiRewrite":
        // 結果はボトムパネルに出る。フォーカスはエディタに戻さず、パネルへ移る余地を残す。
        requestAiSql(action === "aiExplain" ? "explain" : "rewrite");
        return;
      case "format":
        formatSelectionOrAll();
        break;
      case "toggleComment":
        toggleComment(view);
        break;
      case "copy":
        if (selected) void copyToClipboard(selected);
        break;
      case "cut":
        if (selected) {
          void copyToClipboard(selected).then((ok) => {
            // コピーに失敗したら本文を消さない (クリップボードにも残らず失われるため)。
            const v = viewRef.current;
            if (!ok || !v) return;
            const cur = v.state.selection.main;
            if (cur.from === sel.from && cur.to === sel.to) {
              v.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" } });
            }
          });
        }
        break;
      case "selectAll":
        selectAll(view);
        break;
      case "saveSnippet":
        saveSelectionOrAll();
        return; // スニペット保存フォームへフォーカスを渡すのでエディタへ戻さない。
    }
    view.focus();
  };

  const openEditorMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const view = viewRef.current;
    if (!view) return;
    e.preventDefault();
    const sel = view.state.selection.main;
    let x = e.clientX;
    let y = e.clientY;
    // キーボード (ContextMenu キー / Shift+F10) 由来は座標が 0,0 で届くので、
    // キャレット位置へ開く (#1113: キーボードだけでメニューへ到達できるように)。
    if (x === 0 && y === 0) {
      const caret = view.coordsAtPos(sel.head);
      if (caret) {
        x = caret.left;
        y = caret.bottom;
      }
    }
    setEditorMenu({
      x,
      y,
      hasSelection: !sel.empty && view.state.sliceDoc(sel.from, sel.to).trim().length > 0,
      hasContent: view.state.doc.toString().trim().length > 0,
    });
  };

  const editorMenuItems = (): ContextMenuEntry[] => {
    if (!editorMenu) return [];
    const combos: Partial<Record<ShortcutId, string>> = {
      run: runCombo,
      runStatement: runStatementCombo,
      preview: previewCombo,
      format: formatCombo,
      explain: explainCombo,
    };
    return sqlEditorMenuSpec({
      hasSelection: editorMenu.hasSelection,
      hasContent: editorMenu.hasContent,
      disabled: !!disabled,
      explainMode: !!explainMode,
      canPreview: !!onPreview,
      canExplain: !!onExplain,
      canSaveSnippet: !!onSaveSnippet,
      canAi: aiAvailable && !!sessionId && !!onAiSqlAction,
    }).map((spec) => {
      if ("separator" in spec) return spec;
      const combo = spec.shortcutId ? combos[spec.shortcutId] : undefined;
      return {
        label: t(spec.labelKey),
        icon: spec.icon,
        shortcut: combo ? formatComboLabel(combo) : undefined,
        disabled: spec.disabled,
        title: spec.disabled && spec.disabledReasonKey ? t(spec.disabledReasonKey) : undefined,
        onSelect: () => {
          setEditorMenu(null);
          runEditorMenuAction(spec.action);
        },
      };
    });
  };

  const runLabel = explainMode
    ? t("editorExplain")
    : activeTable
      ? t("editorRunOnTable", { table: activeTable.name })
      : t("editorRun");
  const runTitleBase = explainMode
    ? t("editorExplainTitle")
    : activeTable
      ? t("editorRunOnTableTitle", { database: activeTable.database, table: activeTable.name })
      : t("editorRunTitle");
  const runTitle = labelWithShortcut(runTitleBase, runCombo);

  // When a button is disabled, its tooltip explains why instead of describing
  // the (currently unavailable) action — so a greyed-out button never looks
  // like a bug to a first-time user.
  const disabledReason = disabled
    ? t("editorHintDisabled")
    : !hasContent
      ? t("editorHintEmpty")
      : null;

  // Run / Preview Badge の状態キー。`idle` / `running` / `disabled` の 3 値だけを
  // 扱い、`done` / `error` はトースト/ステータスバー側で表現する (Badge が滞留
  // しないように — 連打しても次の `idle` へすぐ戻る)。
  const runState: "idle" | "running" | "disabled" =
    disabled || !hasContent ? "disabled" : running ? "running" : "idle";
  const runIconPlay = <Icon name="play" size={ICON_SIZES.sm} />;
  const runIconSpinner = <Spinner size={12} />;
  const runStates: Record<"idle" | "running" | "disabled", BadgeState> = {
    // Run は実際に書き込みうる本実行なので緑 (success)、Dry Run は常にロールバック
    // するお試し実行なので橙 (warning) で色分けし、押す前に取り違えないようにする。
    // (一度「主要 = accent / 補助 = 中立」に統一したが、2 つの実行ボタンが見分け
    // にくくなったという声で色分けへ戻した。)
    idle: { label: runLabel, tone: "success", icon: runIconPlay },
    // 実行中はスピナーのみを表示する。Run/Preview は英語ラベルのボタンであり、
    // 日本語の状態テキスト ("実行中...") を併記するとスピナーと意味が重複し、ボタン
    // ラベルとの言語的な齟齬も生むため、可視テキストは落とす。SR 向けには
    // `srLabel` でアナウンスを残す。実行中も同じ色を保ち状態の連続性を出す。
    running: { label: "", srLabel: t("editorRunRunning"), tone: "success", icon: runIconSpinner },
    disabled: { label: runLabel, tone: "neutral", icon: runIconPlay },
  };

  // Preview Badge も `idle` / `running` / `disabled` の 3 状態を持つ。`running` は
  // 親 (App.tsx) が `previewRunning` を真にしたタイミングで遷移する。`done` / `error`
  // はトースト/ステータスバー側で表現し、Badge 自体は短時間で `idle` に戻る。
  const previewState: "idle" | "running" | "disabled" =
    disabled || !hasContent ? "disabled" : previewRunning ? "running" : "idle";
  const previewIconEye = <Icon name="eye" size={ICON_SIZES.sm} strokeWidth={ICON_STROKE.thin} />;
  const previewStates: Record<"idle" | "running" | "disabled", BadgeState> = {
    // Dry Run は安全なプレビュー実行 (常にロールバック)。Run の緑と取り違えない
    // よう橙 (warning) で色分けする。
    idle: { label: t("editorPreview"), tone: "warning", icon: previewIconEye },
    running: { label: "", srLabel: t("editorPreviewRunning"), tone: "warning", icon: runIconSpinner },
    disabled: { label: t("editorPreview"), tone: "neutral", icon: previewIconEye },
  };

  // ツールバーの副次アクション (#915)。主要アクション (Run / Preview / Format) は
  // 常時表示のままにし、それ以外は「…」メニューへ畳む。以前は幅が狭いときに
  // `flexWrap` で 2〜3 段へ折り返しており、多機能タブほどエディタの縦領域が削られ
  // ていた。畳む対象は「押す頻度が主要 3 つより低く、かつ押せなくても危険側に倒れ
  // ない」もの — 緊急クエリ実行モードのトグルだけは、状態が常に見えていること自体
  // が安全網なので畳まずツールバーに残す。
  // 無効時の理由 (`disabledReason` 等) は `title` としてそのまま持ち込むので、
  // ツールバーのボタンだったときと同じ説明がメニュー上でも読める。
  const overflowItems: ContextMenuEntry[] = [];
  if (onRunInNewTab && !explainMode) {
    overflowItems.push({
      label: t("editorRunNewTab"),
      icon: "play",
      // 既定では runNewTab と preview が同じコンボ (スコープ違いで住み分け) なので、
      // エディタ内で押すと別動作になるときはキー表記を出さない (嘘の案内を避ける)。
      shortcut:
        runNewTabCombo && runNewTabCombo !== previewCombo ? formatComboLabel(runNewTabCombo) : undefined,
      title: disabledReason ?? t("editorRunNewTabTitle"),
      disabled: disabled || !hasContent,
      onSelect: runInNewTabSelectionOrAll,
    });
  }
  if (onExplain) {
    overflowItems.push({
      label: t("editorExplain"),
      icon: "explain",
      title: disabledReason ?? t("editorExplainTitle"),
      disabled: disabled || !hasContent,
      onSelect: explainSelectionOrAll,
    });
  }
  if (onSaveSnippet) {
    overflowItems.push({
      label: t("editorSaveSnippet"),
      icon: "snippet",
      title: disabledReason ?? t("editorSaveSnippetTitle"),
      disabled: disabled || !hasContent,
      onSelect: saveSelectionOrAll,
    });
  }
  // .sql スクリプトの明示的な「開く」/「名前を付けて保存」(#918)。D&D
  // (`App.tsx` の `handleFilesDropped`) と読み込みロジックを共有する。
  if (onOpenFile) {
    overflowItems.push({
      label: t("editorOpenFile"),
      icon: "upload",
      // 「開く」は本文が空でも押せる (開く先は新規タブ) ので、`disabledReason`
      // をそのまま使うと空のときだけ「先に SQL を入力してください」という
      // 的外れな無効理由が出る。無効になるのは未接続のときだけ。
      title: disabled ? t("editorHintDisabled") : t("editorOpenFileTitle"),
      disabled,
      onSelect: onOpenFile,
    });
  }
  if (onSaveFile) {
    overflowItems.push({
      label: t("editorSaveFile"),
      icon: "download",
      title: disabledReason ?? t("editorSaveFileTitle"),
      disabled: disabled || !hasContent,
      onSelect: onSaveFile,
    });
  }
  if (onBroadcast && !explainMode) {
    overflowItems.push({
      label: t("editorBroadcast"),
      icon: "broadcast",
      title: disabled
        ? t("editorHintDisabled")
        : !hasContent
          ? t("editorHintEmpty")
          : !broadcastAvailable
            ? t("broadcastDisabledSingle")
            : t("editorBroadcastTitle"),
      disabled: disabled || !hasContent || !broadcastAvailable,
      onSelect: broadcastSelectionOrAll,
    });
  }
  if (sessionId && !explainMode) {
    overflowItems.push({
      label: t("editorBuilder"),
      icon: "tools",
      title: disabled ? t("editorHintDisabled") : t("editorBuilderTitle"),
      disabled,
      onSelect: () => setShowBuilder(true),
    });
  }

  return (
    <Box
      display="flex"
      flexDirection="column"
      flex="1 1 auto"
      minHeight={0}
      minWidth={0}
    >
      <Box
        display="flex"
        gap="2"
        alignItems="center"
        py="1.5"
        px="2.5"
        borderBottom="1px solid"
        borderColor="app.border"
        bg="app.toolbar"
        // 折り返しは行わない (#915)。副次アクションは「…」へ畳んであるため、
        // 幅が狭くてもツールバーは 1 段のまま = 高さが幅に依らず一定になる。
        // ボタンは recipe の `flexShrink: 0` で潰れないので、極端に狭いときの
        // 逃げ道だけ横スクロールとして残す (縦に伸ばさない、が主眼)。
        overflowX="auto"
        css={{
          "& .btn-spinner": {
            borderColor: "color-mix(in srgb, currentColor 35%, transparent)",
            borderTopColor: "currentColor",
          },
        }}
      >
        <MultiStateBadge
          state={runState}
          states={runStates}
          onClick={runSelectionOrAll}
          data-testid="query-editor-run"
          disabled={runState === "disabled"}
          title={disabledReason ?? runTitle}
        />
        {onPreview && (
          <MultiStateBadge
            state={previewState}
            states={previewStates}
            onClick={previewSelectionOrAll}
            disabled={previewState === "disabled"}
            title={disabledReason ?? labelWithShortcut(t("editorPreviewTitle"), previewCombo)}
          />
        )}
        {/* 影響行数プリフライトのバッジ (#737)。実行ボタン付近に常時表示する。 */}
        <PreflightBadge result={preflight} />
        <ToolbarButton
          onClick={formatSelectionOrAll}
          disabled={disabled || !hasContent}
          title={disabledReason ?? t("editorFormatTitle")}
        >
          <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
            <Icon name="format" size={ICON_SIZES.sm} strokeWidth={ICON_STROKE.thin} />
          </chakra.span>
          {t("editorFormat")}
        </ToolbarButton>
        {/* AI にクエリを依頼 (#691)。AI 有効かつ API キー登録済みで接続中のときだけ出す。 */}
        {aiAvailable && sessionId && !explainMode && (
          <ToolbarButton
            onClick={() => setShowAiQuery(true)}
            disabled={disabled}
            title={disabledReason ?? t("editorAiQueryTitle")}
            data-testid="query-editor-ai"
          >
            <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
              <Icon name="sparkles" size={ICON_SIZES.sm} strokeWidth={ICON_STROKE.thin} />
            </chakra.span>
            {t("editorAiQuery")}
          </ToolbarButton>
        )}
        {/* 副次アクションのオーバーフロー (#915)。項目が 1 つも無い呼び出し
            (プレビュー用の最小構成など) ではボタン自体を出さない。 */}
        {overflowItems.length > 0 && (
          <ToolbarButton
            onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
              // メニューはクリック位置ではなくボタンの下端に開き、ツールバーの
              // 並びと視覚的に繋がるようにする。
              const r = e.currentTarget.getBoundingClientRect();
              setOverflowAnchor({ x: r.left, y: r.bottom + 4 });
            }}
            title={t("editorMoreActionsTitle")}
            aria-label={t("editorMoreActions")}
            aria-haspopup="menu"
            aria-expanded={!!overflowAnchor}
          >
            <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
              <Icon name="more" size={ICON_SIZES.sm} />
            </chakra.span>
          </ToolbarButton>
        )}
        {/* 緊急クエリ実行モード (read-only セッション限定)。オンの間は書き込み文が
            バックエンドの read-only ガードを通るため、危険色で常時目立たせる。 */}
        {readOnly && sessionId && !explainMode && onToggleEmergencyMode && (
          <chakra.span
            display="inline-flex"
            alignItems="center"
            gap="1.5"
            px="2"
            py="0.5"
            ml="1"
            fontSize="xs"
            fontWeight={emergencyMode ? 700 : 500}
            color={emergencyMode ? "app.dangerFg" : "app.textMuted"}
            bg={emergencyMode ? "app.dangerBg" : "transparent"}
            border="1px solid"
            borderColor={emergencyMode ? "app.dangerBg" : "app.border"}
            borderRadius="pill"
          >
            {/* native title だった全体の説明文は、`Switch` 自体が既に共有
                Tooltip (#814) を内蔵しているのでその `title` プロップへ委譲する。 */}
            <Switch
              size="sm"
              checked={!!emergencyMode}
              onChange={onToggleEmergencyMode}
              label={t("editorEmergencyMode")}
              title={t("editorEmergencyModeTitle")}
            />
          </chakra.span>
        )}
        {onToggleFocus && (
          <>
            <chakra.span flex="1" minWidth="2" aria-hidden />
            <ToolbarButton
              onClick={onToggleFocus}
              title={focusMode ? t("editorRestoreTitle") : t("editorFocusTitle")}
              aria-label={focusMode ? t("editorRestoreTitle") : t("editorFocusTitle")}
              aria-pressed={!!focusMode}
            >
              <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
                <Icon
                  name={focusMode ? "minimize" : "maximize"}
                  size={ICON_SIZES.sm}
                  strokeWidth={ICON_STROKE.thin}
                />
              </chakra.span>
            </ToolbarButton>
          </>
        )}
      </Box>
      {overflowAnchor && (
        <ContextMenu
          x={overflowAnchor.x}
          y={overflowAnchor.y}
          items={overflowItems}
          onClose={() => setOverflowAnchor(null)}
        />
      )}
      <Box
        ref={hostRef}
        data-testid="query-editor"
        flex="1"
        overflow="auto"
        bg="app.surface"
        onContextMenu={openEditorMenu}
      />
      {editorMenu && (
        <ContextMenu
          x={editorMenu.x}
          y={editorMenu.y}
          items={editorMenuItems()}
          onClose={() => setEditorMenu(null)}
        />
      )}
      <AnimatePresence>
        {showAiQuery && aiAvailable && sessionId && !explainMode && (
          <AiQueryModal
            sessionId={sessionId}
            driver={driver}
            database={defaultDatabase ?? activeTable?.database ?? null}
            readOnly={!!readOnly}
            isProduction={!!isProduction}
            onInsert={insertAtCursor}
            onOpenInNewTab={(sql, db) => onOpenSqlInNewTab?.(sql, db)}
            onClose={() => setShowAiQuery(false)}
          />
        )}
        {showBuilder && sessionId && !explainMode && (
          <QueryBuilder
            sessionId={sessionId}
            driver={driver}
            defaultDatabase={defaultDatabase ?? activeTable?.database ?? null}
            defaultTable={activeTable?.name ?? null}
            initialSnapshot={builderSnapshot}
            readOnly={readOnly}
            onExecute={(builtSql) => onRun(builtSql)}
            onPreview={onPreview ? (builtSql) => onPreview(builtSql) : undefined}
            onPersist={onBuilderPersist}
            onInsertToEditor={insertAtCursor}
            onClose={() => setShowBuilder(false)}
          />
        )}
      </AnimatePresence>
    </Box>
  );
}));
