import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Box, chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { sql, type SQLNamespace } from "@codemirror/lang-sql";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
} from "@codemirror/autocomplete";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { format as formatSql } from "sql-formatter";
import type { TableSchema } from "../api/tauri";
import { useT } from "../i18n";
import { springs } from "../motion";
import { QueryBuilder, type QueryBuilderSnapshot } from "./QueryBuilder";
import { codeMirrorSqlDialectFor, sqlFormatterLanguageFor } from "./sqlDialect";
import { Spinner } from "./Spinner";
import { Button } from "./ui";
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
function ToolbarButton({ children, ...rest }: ComponentProps<typeof Button> & { children: ReactNode }) {
  return (
    <motion.span
      style={{ display: "inline-flex" }}
      whileHover={!rest.disabled ? { scale: 1.04 } : undefined}
      whileTap={!rest.disabled ? { scale: 0.97 } : undefined}
      transition={springs.gentle}
    >
      <Button {...rest}>{children}</Button>
    </motion.span>
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
  /** True while this tab's Run is streaming — flips the Run badge to its `running` state. */
  running?: boolean;
  /** True while this tab's Dry Run preview is streaming — flips the Preview badge to `running`. */
  previewRunning?: boolean;
  onPreview?: (sql: string) => void;
  onExplain?: (sql: string) => void;
  onChange?: (sql: string) => void;
  onFormatError?: (error: string) => void;
  onSaveSnippet?: (sql: string) => void;
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
  initialSql?: string;
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
   * 直近に実行したクエリの一覧 (最新が先頭)。エディタ 1 行目での ↑ / 末尾行での ↓
   * による履歴ナビゲーション (#325) に使う。未接続時などは空/undefined。
   */
  queryHistory?: string[];
}

export interface QueryEditorHandle {
  /** Inserts text at the current cursor (replacing any selection). */
  insertText: (text: string) => void;
  /** Replaces the entire editor contents (used to restore a history entry). */
  setText: (text: string) => void;
}

function formatEditorContent(
  view: EditorView,
  driver: string,
  onError?: (message: string) => void,
): boolean {
  const sel = view.state.selection.main;
  const isSelection = !sel.empty;
  const text = isSelection
    ? view.state.sliceDoc(sel.from, sel.to)
    : view.state.doc.toString();
  if (text.trim().length === 0) return false;
  let formatted: string;
  try {
    formatted = formatSql(text, { language: sqlFormatterLanguageFor(driver) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onError?.(message);
    return true;
  }
  if (formatted === text) return true;
  if (isSelection) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: formatted },
      selection: { anchor: sel.from, head: sel.from + formatted.length },
    });
  } else {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: formatted },
    });
  }
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

function buildSqlExtension(
  driver: string,
  schemaTable: SchemaTable | null | undefined,
  databaseSchema: TableSchema[] | null | undefined,
  defaultDatabase: string | null | undefined,
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
    schema =
      namespaceDb && driver !== "sqlite"
        ? { ...tableColumns, [namespaceDb]: { ...tableColumns } }
        : { ...tableColumns };
    // Prefer the active table for unqualified column completion; otherwise the
    // dialect still completes once the user qualifies with a table name.
    defaultTable = schemaTable?.name;
    defaultSchema = namespaceDb;
  }
  return sql({
    dialect: codeMirrorSqlDialectFor(driver),
    schema,
    defaultTable,
    defaultSchema,
    upperCaseKeywords: true,
  });
}

export const QueryEditor = forwardRef<QueryEditorHandle, Props>(function QueryEditor({
  onRun,
  running,
  previewRunning,
  onPreview,
  onExplain,
  onChange,
  onFormatError,
  onSaveSnippet,
  disabled,
  schemaTable,
  databaseSchema,
  activeTable,
  initialSql,
  sessionId,
  defaultDatabase,
  explainMode,
  driver = "mysql",
  builderSnapshot,
  onBuilderPersist,
  readOnly,
  queryHistory,
}: Props, ref) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const sqlCompartment = useMemo(() => new Compartment(), []);
  const [hasContent, setHasContent] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onFormatErrorRef = useRef(onFormatError);
  onFormatErrorRef.current = onFormatError;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;
  const driverRef = useRef(driver);
  driverRef.current = driver;
  // 履歴ナビゲーション (#325) 用。エディタは初回だけ生成されキーマップ内のクロージャ
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

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: startDoc,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          syntaxHighlighting(noobDBHighlightStyle, { fallback: true }),
          autocompletion(),
          // エディタ内検索・置換 (#464)。検索パネルはエディタ上部に出し、選択語の
          // 同一語ハイライトも有効化する。キーバインドは下の keymap に searchKeymap
          // を含める (Mod-f はエディタにフォーカスがあるときだけ起動し、結果横断検索
          // の Cmd/Ctrl+F とはフォーカス文脈で住み分ける — App 側でガード)。
          search({ top: true }),
          highlightSelectionMatches(),
          sqlCompartment.of(buildSqlExtension(driver, schemaTable, databaseSchema, defaultDatabase)),
          keymap.of([
            { key: "Tab", run: acceptCompletion },
            // ↑ / ↓ による実行済みクエリの履歴ナビゲーション (#325)。1 行目での ↑ /
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
            {
              key: "Mod-Enter",
              run: (v) => {
                const text = selectionOrAllText(v);
                if (text !== null) {
                  resetHistoryNav();
                  onRunRef.current(text);
                }
                return true;
              },
            },
            {
              key: "Shift-Mod-Enter",
              run: (v) => {
                const preview = onPreviewRef.current;
                if (!preview) return false;
                const text = selectionOrAllText(v);
                if (text !== null) preview(text);
                return true;
              },
            },
            {
              key: "Mod-Shift-f",
              preventDefault: true,
              run: (v) => formatEditorContent(v, driverRef.current, onFormatErrorRef.current),
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
              onChangeRef.current?.(u.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    setHasContent(startDoc.length > 0);
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schemaKey = schemaTable
    ? `${schemaTable.database}.${schemaTable.name}|${schemaTable.columns.join(",")}`
    : "";

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: sqlCompartment.reconfigure(
        buildSqlExtension(driver, schemaTable, databaseSchema, defaultDatabase),
      ),
    });
    // `databaseSchema` is a stable reference from the parent's cache: it only
    // changes identity on (re)fetch or when the editor's database changes, so
    // depending on it directly is both correct and cheap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey, driver, databaseSchema, defaultDatabase]);

  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      const view = viewRef.current;
      if (!view) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
      });
      view.focus();
    },
    setText: (text: string) => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
      });
      view.focus();
    },
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
  const runTitle = `${runTitleBase} (${t("editorRunShortcut")})`;

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
  const runIconPlay = (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M4 3.5v9a.5.5 0 0 0 .77.42l7-4.5a.5.5 0 0 0 0-.84l-7-4.5A.5.5 0 0 0 4 3.5z" />
    </svg>
  );
  const runIconSpinner = <Spinner size={12} />;
  const runStates: Record<"idle" | "running" | "disabled", BadgeState> = {
    // Run はエディタの主要アクションなので、アクセント色 (primary 相当) で
    // ツールバー上で唯一際立たせる (#283 の「主要アクション = primary」)。
    idle: { label: runLabel, tone: "accent", icon: runIconPlay },
    // 実行中はスピナーのみを表示する。Run/Preview は英語ラベルのボタンであり、
    // 日本語の状態テキスト ("実行中...") を併記するとスピナーと意味が重複し、ボタン
    // ラベルとの言語的な齟齬も生むため、可視テキストは落とす。SR 向けには
    // `srLabel` でアナウンスを残す。実行中もアクセント色を保ち状態の連続性を出す。
    running: { label: "", srLabel: t("editorRunRunning"), tone: "accent", icon: runIconSpinner },
    disabled: { label: runLabel, tone: "neutral", icon: runIconPlay },
  };

  // Preview Badge も `idle` / `running` / `disabled` の 3 状態を持つ。`running` は
  // 親 (App.tsx) が `previewRunning` を真にしたタイミングで遷移する。`done` / `error`
  // はトースト/ステータスバー側で表現し、Badge 自体は短時間で `idle` に戻る。
  const previewState: "idle" | "running" | "disabled" =
    disabled || !hasContent ? "disabled" : previewRunning ? "running" : "idle";
  const previewIconEye = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1.5 8s2.5-5 6.5-5 6.5 5 6.5 5-2.5 5-6.5 5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
  const previewStates: Record<"idle" | "running" | "disabled", BadgeState> = {
    // Dry Run は安全なプレビュー実行 (常にロールバック) なので、Run のような
    // 主役色は使わず中立トーンに統一し、補助アクションとして落ち着かせる (#283)。
    idle: { label: t("editorPreview"), tone: "neutral", icon: previewIconEye },
    running: { label: "", srLabel: t("editorPreviewRunning"), tone: "neutral", icon: runIconSpinner },
    disabled: { label: t("editorPreview"), tone: "neutral", icon: previewIconEye },
  };

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
        css={{
          "@media (max-width: 760px)": { flexWrap: "wrap", rowGap: "1.5" },
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
          disabled={runState === "disabled"}
          title={disabledReason ?? runTitle}
        />
        {onPreview && (
          <MultiStateBadge
            state={previewState}
            states={previewStates}
            onClick={previewSelectionOrAll}
            disabled={previewState === "disabled"}
            title={disabledReason ?? `${t("editorPreviewTitle")} (${t("editorPreviewShortcut")})`}
          />
        )}
        <ToolbarButton
          onClick={formatSelectionOrAll}
          disabled={disabled || !hasContent}
          title={disabledReason ?? t("editorFormatTitle")}
        >
          <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3h12" />
              <path d="M2 7h8" />
              <path d="M2 11h10" />
              <path d="M2 15h6" />
            </svg>
          </chakra.span>
          {t("editorFormat")}
        </ToolbarButton>
        {onExplain && (
          <ToolbarButton
            onClick={explainSelectionOrAll}
            disabled={disabled || !hasContent}
            title={disabledReason ?? t("editorExplainTitle")}
          >
            <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="1.5" width="4" height="3" rx="0.5" />
                <rect x="1.5" y="11.5" width="4" height="3" rx="0.5" />
                <rect x="10.5" y="11.5" width="4" height="3" rx="0.5" />
                <path d="M8 4.5v2.5M3.5 11.5V9h9v2.5" />
              </svg>
            </chakra.span>
            {t("editorExplain")}
          </ToolbarButton>
        )}
        {onSaveSnippet && (
          <ToolbarButton
            onClick={saveSelectionOrAll}
            disabled={disabled || !hasContent}
            title={disabledReason ?? t("editorSaveSnippetTitle")}
          >
            <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
                <path d="M5 2v4h5V2" />
                <path d="M5 10h6" />
              </svg>
            </chakra.span>
            {t("editorSaveSnippet")}
          </ToolbarButton>
        )}
        {sessionId && !explainMode && (
          <ToolbarButton
            onClick={() => setShowBuilder(true)}
            disabled={disabled}
            title={disabled ? t("editorHintDisabled") : t("editorBuilderTitle")}
          >
            <chakra.span display="inline-flex" flexShrink={0} aria-hidden>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11.5 2.5a3 3 0 0 0-3.9 3.6L2.5 11.2a1.5 1.5 0 1 0 2.1 2.1l5.1-5.1a3 3 0 0 0 3.6-3.9l-1.7 1.7-1.5-.4-.4-1.5z" />
              </svg>
            </chakra.span>
            {t("editorBuilder")}
          </ToolbarButton>
        )}
      </Box>
      <Box ref={hostRef} flex="1" overflow="auto" bg="app.surface" />
      <AnimatePresence>
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
            onClose={() => setShowBuilder(false)}
          />
        )}
      </AnimatePresence>
    </Box>
  );
});
