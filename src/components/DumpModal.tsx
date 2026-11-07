import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { save } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, DumpOptions, listenDumpStream, type DriverKind, type DumpToolStatus } from "../api/tauri";
import { useT } from "../i18n";
import { transitions, variants } from "../motion";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { CodePreview, ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { Callout } from "./Callout";
import { JobOutcome, JobProgressDetail, type JobProgressDetailProps } from "./JobProgress";
import type { SemanticRole } from "../semanticColors";
import { copyToClipboard } from "./clipboard";
import { Icon, ICON_SIZES } from "./Icon";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { DumpEngineSelector, DumpOptionGroups, DumpPgSchemaField } from "./DumpOptionsFields";
import { isAbsolutePath } from "./pathUtil";
import { dumpOptionLock, resolveDumpOptions, type DumpBoolOptionKey } from "../dumpOptionLocks";
import {
  DEFAULT_DUMP_OPTIONS,
  DRIVER_OPTIONS,
  DUMP_TOOL,
  NATIVE_DUMP_DRIVERS,
  visibleOptionRows,
} from "../dumpOptionForm";
import { dirnameOf, joinDirAndName, loadDumpPrefs, saveDumpPrefs, type DumpBoolKey } from "../inputMemory";

let dumpStreamSeq = 0;
/** Unique stream id per dump run so progress events / cancel target it (#686). */
function makeDumpStreamId(): string {
  dumpStreamSeq += 1;
  return `dump_${Date.now().toString(36)}_${dumpStreamSeq.toString(36)}`;
}

/** Human-readable byte size (e.g. "1.2 MB"). Base-1000 for familiarity. */
function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

interface DumpProgress {
  bytes: number;
  elapsedMs: number;
  tables: number | null;
  tablesTotal: number | null;
}

/** ダンプの進捗を共通部品 (`JobProgressDetail`、#2122) の入力へ写す。テーブル総数が分かる間だけバーと ETA が出る。 */
function dumpDetailProps(progress: DumpProgress, t: ReturnType<typeof useT>): JobProgressDetailProps {
  return {
    done: progress.tables ?? 0,
    total: progress.tablesTotal,
    elapsedMs: progress.elapsedMs,
    testId: "dump-progress-detail",
    stats: [
      ...(progress.tablesTotal != null
        ? [{ label: t("dumpStatTables"), value: progress.tables ?? 0, sub: `/ ${progress.tablesTotal}` }]
        : []),
      { label: t("dumpStatBytes"), value: formatBytes(progress.bytes) },
    ],
  };
}

function DumpProgressDetail({
  progress,
  running,
  tone,
}: {
  progress: DumpProgress;
  running?: boolean;
  tone?: SemanticRole;
}) {
  const t = useT();
  return <JobProgressDetail {...dumpDetailProps(progress, t)} running={running} tone={tone} />;
}

/** 終了後: バーを意味色で止め、結果を Callout で示す (#2092)。進捗イベントが 0 件なら Callout のみ。 */
function DumpOutcome({
  outcome,
}: {
  outcome: {
    kind: "done" | "cancelled" | "error";
    progress: DumpProgress | null;
    bytes: number;
    elapsedMs: number;
  };
}) {
  const t = useT();
  const values = { bytes: formatBytes(outcome.bytes), secs: (outcome.elapsedMs / 1000).toFixed(1) };
  return (
    <JobOutcome
      kind={outcome.kind}
      tone={outcome.kind === "done" ? "success" : "warning"}
      detail={
        outcome.progress &&
        dumpDetailProps({ ...outcome.progress, bytes: outcome.bytes, elapsedMs: outcome.elapsedMs }, t)
      }
      message={t(outcome.kind === "done" ? "dumpResultDone" : "dumpResultCancelled", values)}
    />
  );
}

interface Props {
  sessionId: string;
  database: string;
  driver: DriverKind;
  /**
   * 指定すると、データベース全体ではなくこのテーブルだけをダンプする (#1399)。スキーマツリーで
   * 複数選択したテーブルの一括ダンプ。ルーチン / イベントは (MySQL ではバックエンドが
   * `--routines` / `--events` を付けないので) 対象外になるため、そのスイッチは隠す。
   * PostgreSQL ではツリーの階層がスキーマなので、`database` は `--table` の修飾にだけ使われる
   * (接続先 DB はプロファイルのもの)。
   */
  tables?: string[];
  /** 接続プロファイル ID。前回のスイッチと保存先ディレクトリをプロファイルごとに記憶する (#1631)。 */
  profileId?: string;
  onClose: () => void;
}

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, "0");
}

function timestamp(now = new Date()): string {
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    "_" +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

function sanitizeForFilename(s: string): string {
  return s
    .replace(/[\\/:*?"<>| -]/g, "_")
    .replace(/[ .]+$/, "")
    .trim();
}

function defaultBasename(database: string, tableCount?: number): string {
  const schema = sanitizeForFilename(database) || "database";
  return tableCount ? `${schema}_${tableCount}tables_dump_${timestamp()}` : `${schema}_dump_${timestamp()}`;
}

/**
 * ダンプ用ツールが見つからないときの案内と、ワンクリック導入 (winget / Homebrew)。
 *
 * 「どこに入るのか」で迷わないよう、**この PC (noobDB を実行しているマシン) に入り、
 * SSH の踏み台や DB サーバには入れない**ことと、インストール先のパスを明示する。
 * ダンプはこの PC でツールを起動し、SSH トンネル経由で DB に接続する。
 */
function DumpToolNotice({
  status,
  installing,
  installError,
  onInstall,
  busy,
  nativeSelected,
  autoSwitched,
}: {
  status: DumpToolStatus;
  installing: boolean;
  installError: string | null;
  onInstall: () => void;
  /** ダンプ実行中はインストールさせない (完了時の状態リセットが実行中のダンプを壊すため)。 */
  busy: boolean;
  /** 内蔵生成を選んでいるとき (未導入のため自動で切り替えた場合を含む) は警告ではなく情報の帯にする。 */
  nativeSelected: boolean;
  /** 未導入を検出して**自動で**内蔵へ切り替えたときだけ「切り替えました」と伝える。 */
  autoSwitched: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const plan = status.install;
  return (
    <Callout
      tone={nativeSelected ? "info" : "warning"}
      title={
        autoSwitched
          ? t("dumpEngineAutoSwitched", { tool: status.tool })
          : t("dumpToolMissingTitle", { tool: status.tool })
      }
    >
      <chakra.div display="flex" flexDirection="column" gap="2" fontSize="sm" lineHeight={1.5}>
        <chakra.div>{t("dumpToolWhere", { tool: status.tool })}</chakra.div>
        {plan ? (
          <>
            <chakra.div>
              <chakra.span fontWeight={600}>{t("dumpToolLocation")}</chakra.span>{" "}
              <chakra.code fontFamily="var(--font-mono)" wordBreak="break-all">
                {plan.location}
              </chakra.code>
            </chakra.div>
            <chakra.div fontWeight={600}>
              {plan.oneClick ? t("dumpToolCommandAuto") : t("dumpToolCommandManual")}
            </chakra.div>
            <chakra.div display="flex" alignItems="flex-start" gap="1">
              <CodePreview wrap flex="1" minW={0}>
                {plan.command}
              </CodePreview>
              <Tooltip label={t("dumpToolCopyCommand")}>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={t("dumpToolCopyCommand")}
                  onClick={async () => {
                    const ok = await copyToClipboard(plan.command);
                    if (ok) toast.success(t("dumpToolCopied"));
                  }}
                >
                  <Icon name="copy" size={ICON_SIZES.sm} />
                </Button>
              </Tooltip>
            </chakra.div>
            {plan.oneClick && (
              <chakra.div display="flex" alignItems="center" gap="2" flexWrap="wrap">
                <LoadingButton
                  type="button"
                  size="sm"
                  variant="primary"
                  loading={installing}
                  disabled={installing || busy}
                  onClick={onInstall}
                >
                  <Icon name="download" size={ICON_SIZES.sm} />
                  {installing ? t("dumpToolInstalling") : t("dumpToolInstall", { tool: status.tool })}
                </LoadingButton>
                <chakra.span fontSize="xs" color="app.textMuted">
                  {t("dumpToolInstallHint")}
                </chakra.span>
              </chakra.div>
            )}
          </>
        ) : (
          <chakra.div>{t("dumpToolNoPlan", { tool: status.tool })}</chakra.div>
        )}
        {installError && <ErrorNote>{t("dumpToolInstallFailed", { error: installError })}</ErrorNote>}
      </chakra.div>
    </Callout>
  );
}

type Status = { kind: "idle" } | { kind: "running" } | { kind: "error"; message: string };

/** テーブル指定のダンプでは意味を持たない (テーブル指定時はバックエンドが無効にする) スイッチ。 */
const TABLE_SCOPE_HIDDEN_OPTIONS: ReadonlySet<DumpBoolOptionKey> = new Set<DumpBoolOptionKey>([
  "routines",
  "events",
  "sqliteSnapshot",
]);

/** 保存先の拡張子。SQL / gzip 圧縮 SQL / SQLite スナップショット (#1624) / その gzip。 */
function dumpExtension(o: Pick<DumpOptions, "gzip" | "sqliteSnapshot">): string {
  const base = o.sqliteSnapshot ? "db" : "sql";
  return o.gzip ? `${base}.gz` : base;
}

/** 保存先の拡張子を新しいオプションに追従させる (手で別の名前にした場合は触らない)。 */
function swapDumpExtension(path: string, next: Pick<DumpOptions, "gzip" | "sqliteSnapshot">): string {
  return path.replace(/\.(sql\.gz|sql|db\.gz|db)$/i, `.${dumpExtension(next)}`);
}

/** 保存ダイアログの拡張子フィルタ。 */
function dumpFilter(o: Pick<DumpOptions, "gzip" | "sqliteSnapshot">): { name: string; extensions: string[] } {
  if (o.sqliteSnapshot) return { name: "SQLite", extensions: o.gzip ? ["gz"] : ["db"] };
  return { name: "SQL", extensions: o.gzip ? ["gz"] : ["sql"] };
}

export function DumpModal({ sessionId, database, driver, tables, profileId, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const tableScope = tables && tables.length > 0 ? tables : null;
  const initialBasename = useMemo(
    () => defaultBasename(database, tableScope?.length),
    [database, tableScope?.length],
  );
  // 前回のスイッチと保存先ディレクトリ (プロファイル単位, #1631)。この接続のドライバで表示するスイッチ
  // だけを復元する (表示されない値を黙って持ち込まない)。
  const [remembered] = useState(() => {
    const prefs = loadDumpPrefs(profileId);
    if (!prefs) return null;
    const shown = new Set<DumpBoolKey>(
      DRIVER_OPTIONS[driver].filter((k) => !(tableScope && TABLE_SCOPE_HIDDEN_OPTIONS.has(k))),
    );
    const options: Partial<DumpOptions> = {};
    for (const [k, v] of Object.entries(prefs.options)) {
      if (shown.has(k as DumpBoolKey)) (options as Record<string, boolean>)[k] = v;
    }
    return { options, dir: prefs.dir };
  });
  const [path, setPath] = useState<string>(() =>
    joinDirAndName(remembered?.dir ?? "", `${initialBasename}.${dumpExtension(remembered?.options ?? {})}`),
  );
  const [options, setOptions] = useState<DumpOptions>(() => {
    const base = { ...DEFAULT_DUMP_OPTIONS, ...remembered?.options };
    // PostgreSQL のツリーの「database」はスキーマ。スキーマノードからの全体ダンプは、タイトルの範囲と
    // 揃えるためスキーマ欄を初期入力する (一括 = tables 指定は送信時に database で固定される)。
    return driver === "postgres" && !(tables && tables.length > 0) ? { ...base, pgSchema: database } : base;
  });
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [progress, setProgress] = useState<DumpProgress | null>(null);
  // 終了後も最後の進捗を意味色のバー + Callout で残す (#2092)。次の実行開始で消す。
  const [outcome, setOutcome] = useState<{
    kind: "done" | "cancelled" | "error";
    progress: DumpProgress | null;
    bytes: number;
    elapsedMs: number;
  } | null>(null);
  const lastProgressRef = useRef<DumpProgress | null>(null);
  const startedAtRef = useRef(0);
  // 終了状態を記録する。所要時間は終了まで含める: 完了はバックエンドの値 (最後の進捗の後の
  // 整形・圧縮も含む)、中止・エラーはクライアント計測。進捗イベントが 0 件でも結果を示せる。
  const recordOutcome = (kind: "done" | "cancelled" | "error", bytes?: number, finalElapsedMs?: number) => {
    const last = lastProgressRef.current;
    setOutcome({
      kind,
      progress: last,
      bytes: bytes ?? last?.bytes ?? 0,
      elapsedMs: finalElapsedMs ?? Math.max(last?.elapsedMs ?? 0, Date.now() - startedAtRef.current),
    });
  };
  // Active dump's stream id + event unlistener, so the modal can cancel and
  // clean up its subscription (#686).
  const streamIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  // ダンプ用の外部ツールがこの PC にあるか (SQLite は不要なので null のまま)。
  const toolName = DUMP_TOOL[driver] ?? null;
  const [toolStatus, setToolStatus] = useState<DumpToolStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  // 未導入で自動的に内蔵生成へ切り替えたか。prefs には元の選択を保存するために覚える。
  const [autoSwitched, setAutoSwitched] = useState(false);
  // 自動切り替え前のルーチン (PostgreSQL は切り替えで ON にするので、prefs には元の値を保存する)。
  // null は「戻す必要なし」(MySQL は切り替えで変えない / 切り替え後にユーザーが自分で変えた)。
  const preAutoRoutinesRef = useRef<boolean | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const refreshToolStatus = useMemo(
    () =>
      async (initial = false) => {
        if (!toolName) return;
        try {
          const next = await api.dumpToolStatus(toolName);
          setToolStatus(next);
          // 最初の検出でツールが無ければ内蔵生成へ切り替える (エラー後の再検出では動かさない)。
          if (initial && next.path == null && !optionsRef.current.native) {
            preAutoRoutinesRef.current = driver === "postgres" ? !!optionsRef.current.routines : null;
            setAutoSwitched(true);
            setOptions((prev) => ({
              ...prev,
              native: true,
              ...(driver === "postgres" ? { routines: true } : {}),
            }));
          }
        } catch {
          // 検出自体の失敗は致命的ではない (実行時のエラーで分かる) ので黙って続ける。
          setToolStatus(null);
        }
      },
    [toolName, driver],
  );
  useEffect(() => {
    void refreshToolStatus(true);
  }, [refreshToolStatus]);
  // ネイティブ生成 (#2033) を選ぶと外部ツールは使わない (SQLite は元から不要)。
  const useNative = NATIVE_DUMP_DRIVERS.has(driver) || !!options.native;
  // 外部ツールのカードを無効にする条件は、どちらのエンジンを選んでいるかと独立にする。
  const toolAbsent = !!toolStatus && toolStatus.path == null;

  const handleInstallTool = async () => {
    if (!toolName || status.kind === "running") return;
    setInstalling(true);
    setInstallError(null);
    try {
      const next = await api.installDumpTool(toolName);
      setToolStatus(next);
      setStatus({ kind: "idle" });
      setOutcome(null);
      toast.success(t("dumpToolInstalled", { tool: toolName, path: next.path ?? "" }));
    } catch (e) {
      setInstallError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  // On unmount mid-dump, detach the event subscription AND cancel the backend
  // stream so it doesn't keep running (and writing) after the modal is gone.
  useEffect(
    () => () => {
      const sid = streamIdRef.current;
      if (sid) {
        void api.cancelStream(sid).catch(() => {
          /* already finished */
        });
      }
      unlistenRef.current?.();
      unlistenRef.current = null;
      streamIdRef.current = null;
    },
    [],
  );

  const isRunning = status.kind === "running";
  const visibleRows = useMemo(
    () => visibleOptionRows(driver, tableScope ? TABLE_SCOPE_HIDDEN_OPTIONS : null),
    [driver, tableScope],
  );

  // 生成エンジンを選べるのは外部ツールのあるドライバだけ (SQLite は常に内蔵)。
  const engineSelectable = !NATIVE_DUMP_DRIVERS.has(driver);
  // 効かないオプションの判定。画面 (無効 + 理由) と実行時の値の上書きが同じ文脈を使う (#2094)。
  const lockCtx = { driver, native: !!options.native, sqliteSnapshot: !!options.sqliteSnapshot };
  const lockOf = (key: DumpBoolOptionKey) => dumpOptionLock(key, lockCtx);

  /** 生成エンジンを選ぶ。PostgreSQL のネイティブ生成は、トリガーが参照する関数を出さないと復元できないので、
   *  内蔵に切り替えたときルーチンも既定でオンにする。 */
  const selectEngine = (native: boolean) => {
    // 選択中のカードの再押下では何も変えない (自動切り替えの記録を落として prefs を上書きしないため)。
    if (isRunning || native === useNative) return;
    setAutoSwitched(false);
    setOptions((prev) => ({
      ...prev,
      native,
      ...(native && !prev.native && driver === "postgres" ? { routines: true } : {}),
    }));
  };

  const toggle = (key: DumpBoolOptionKey) => {
    if (lockOf(key)) return;
    // 自動切り替え後にルーチンを自分で変えたら、その選択をそのまま覚える。
    if (key === "routines") preAutoRoutinesRef.current = null;
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
    // gzip (#1539) / SQLite スナップショット (#1624): 保存先の拡張子を追従させる。
    if (key === "gzip" || key === "sqliteSnapshot") {
      const next = { ...options, [key]: !options[key] };
      setPath((cur) => swapDumpExtension(cur, next));
    }
  };

  const handleBrowse = async () => {
    const selected = await save({
      defaultPath: path || `${initialBasename}.${dumpExtension(options)}`,
      title: t("dumpPickFileTitle"),
      filters: [dumpFilter(options)],
    });
    if (typeof selected === "string" && selected) {
      setPath(selected);
    }
  };

  const cleanupStream = () => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    streamIdRef.current = null;
  };

  const handleDump = async () => {
    let target = path.trim();
    if (!target) return;
    // 既定値の相対名のまま実行すると、GUI プロセスのカレントディレクトリ (Finder 起動では
    // `/` など) 基準で書かれてしまう。絶対パスでなければ先に保存ダイアログで保存先を選ばせる。
    if (!isAbsolutePath(target)) {
      const selected = await save({
        defaultPath: target,
        title: t("dumpPickFileTitle"),
        filters: [dumpFilter(options)],
      });
      if (typeof selected !== "string" || !selected) return;
      setPath(selected);
      target = selected;
    }
    // 次回の初期値にするため、表示中のスイッチと保存先ディレクトリを覚える (秘密情報は含まない, #1631)。
    saveDumpPrefs(profileId, {
      options: Object.fromEntries(
        [...visibleRows.map((row) => row.key), ...(engineSelectable ? (["native"] as const) : [])].map(
          // 自動で内蔵へ切り替えただけなら、元の選択 (外部ツール) を覚える。
          (k) => [
            k,
            autoSwitched && k === "native"
              ? false
              : autoSwitched && k === "routines" && preAutoRoutinesRef.current !== null
                ? preAutoRoutinesRef.current
                : options[k] === true,
          ],
        ),
      ) as Partial<Record<DumpBoolKey, boolean>>,
      dir: dirnameOf(target),
    });
    const resolved = resolveDumpOptions(options, lockCtx);
    const streamId = makeDumpStreamId();
    streamIdRef.current = streamId;
    setStatus({ kind: "running" });
    setProgress(null);
    setOutcome(null);
    lastProgressRef.current = null;
    startedAtRef.current = Date.now();

    try {
      // Subscribe before starting so no early progress event is missed. Both the
      // subscription and the kick-off are in this try/catch so a failure in
      // either can't leave the modal stuck in the "running" state.
      unlistenRef.current = await listenDumpStream(streamId, {
        onProgress: (e) => {
          const p = {
            bytes: e.bytes,
            elapsedMs: e.elapsedMs,
            tables: e.tables,
            tablesTotal: e.tablesTotal,
          };
          lastProgressRef.current = p;
          setProgress(p);
        },
        onDone: (e) => {
          cleanupStream();
          toast.success(t("dumpSuccess", { bytes: e.bytes, path: target }));
          setStatus({ kind: "idle" });
          setProgress(null);
          // 最終サイズは完了イベントの値を優先する (進捗イベントは間引かれうる)。
          recordOutcome("done", e.bytes, e.elapsedMs);
        },
        onError: (e) => {
          cleanupStream();
          setStatus({ kind: "error", message: e.error });
          // ツールが見つからない失敗なら、導入の案内を出すために検出し直す。
          void refreshToolStatus();
          toast.error(t("dumpError", { error: e.error }));
          setProgress(null);
          recordOutcome("error");
        },
        onCancelled: () => {
          cleanupStream();
          setStatus({ kind: "idle" });
          setProgress(null);
          recordOutcome("cancelled");
          toast.info(t("dumpCancelled"));
        },
      });

      await api.dumpDatabase({
        sessionId,
        streamId,
        database,
        path: target,
        // 画面で無効にしたオプションは強制値で送る (表示と実行の一致, #2094)。
        options: tableScope
          ? {
              ...resolved,
              tables: tableScope,
              pgSchema: driver === "postgres" ? database : resolved.pgSchema,
            }
          : resolved,
      });
    } catch (e) {
      // Subscription or kick-off (validation) failure — terminal events never
      // fire in this case, so reset the UI here.
      cleanupStream();
      setStatus({ kind: "error", message: String(e) });
      toast.error(t("dumpError", { error: String(e) }));
      setProgress(null);
      recordOutcome("error");
    }
  };

  const handleCancelDump = async () => {
    const streamId = streamIdRef.current;
    if (!streamId) return;
    // Detach listeners first so the backend's own cancelled event doesn't double
    // up with the local handling (mirrors the query/export cancel flow).
    cleanupStream();
    setStatus({ kind: "idle" });
    setProgress(null);
    recordOutcome("cancelled");
    await api.cancelStream(streamId).catch(() => {
      /* already finished */
    });
    toast.info(t("dumpCancelled"));
  };

  return (
    <Modal
      onSubmit={handleDump}
      submitDisabled={isRunning || installing || !path.trim()}
      submitBusy={isRunning || installing}
      width="620px"
      onClose={onClose}
      closeOnInteractOutside={!isRunning}
      closeOnEscape={!isRunning}
    >
      <ModalHeader onClose={onClose} closeLabel={t("dumpClose")} closeDisabled={isRunning}>
        {tableScope
          ? t("dumpTablesTitle", { database, count: tableScope.length })
          : t("dumpTitle", { database })}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight={1.5}>
          {useNative ? t("dumpNoteNative") : t("dumpNote", { tool: toolName ?? "mysqldump" })}
        </chakra.div>

        {tableScope && (
          <Callout tone="info" title={t("dumpTablesScopeTitle", { count: tableScope.length })}>
            <chakra.div fontSize="sm" wordBreak="break-all" data-testid="dump-tables-scope">
              {tableScope.join(", ")}
            </chakra.div>
            {driver === "mysql" && (
              <chakra.div textStyle="caption" mt="1">
                {t("dumpTablesScopeHint")}
              </chakra.div>
            )}
          </Callout>
        )}

        {engineSelectable && toolName && (
          <DumpEngineSelector
            toolName={toolName}
            useNative={useNative}
            disabled={isRunning}
            toolStatus={toolStatus}
            toolAbsent={toolAbsent}
            onSelect={selectEngine}
          />
        )}

        {/* ツール未導入の案内は出入りでレイアウトが跳ばないよう collapse で開閉する。 */}
        <AnimatePresence initial={false}>
          {engineSelectable && toolStatus && toolStatus.path == null && (
            <motion.div
              key="dump-tool-notice"
              initial={variants.collapse.initial}
              animate={variants.collapse.animate}
              exit={variants.collapse.exit}
              transition={transitions.crossfade}
            >
              <DumpToolNotice
                status={toolStatus}
                installing={installing}
                installError={installError}
                onInstall={() => void handleInstallTool()}
                busy={isRunning}
                nativeSelected={useNative}
                autoSwitched={autoSwitched}
              />
            </motion.div>
          )}
        </AnimatePresence>
        {!useNative && toolStatus?.path && (
          <chakra.div fontSize="xs" color="app.textMuted" wordBreak="break-all">
            {t("dumpToolFound", { tool: toolStatus.tool, path: toolStatus.path })}
          </chakra.div>
        )}

        <DumpOptionGroups
          rows={visibleRows}
          options={options}
          lockOf={lockOf}
          disabled={isRunning}
          onToggle={toggle}
        />
        {driver === "postgres" && !tableScope && (
          <DumpPgSchemaField
            value={options.pgSchema}
            disabled={isRunning}
            onChange={(pgSchema) => setOptions((prev) => ({ ...prev, pgSchema }))}
          />
        )}

        <FormSection>
          <FieldLabel htmlFor="dump-path">{t("dumpSavePath")}</FieldLabel>
          <PathRow>
            <Input
              id="dump-path"
              flex="1"
              minW={0}
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t("dumpSavePathPlaceholder")}
              disabled={isRunning}
            />
            <Button type="button" onClick={handleBrowse} disabled={isRunning}>
              {t("dumpBrowse")}
            </Button>
          </PathRow>
        </FormSection>

        {/* 実行中の進捗表示とエラー表示は状態遷移 (idle → running → done/error)
            の一部なので、瞬間的な差し替えではなくクロスフェードで切り替える
            (#1025)。どちらもトリガーはボタン操作 (実行/キャンセル) で、切替対象
            の内側にフォーカス可能な入力は無いためフォーカス喪失の心配はない。 */}
        <AnimatePresence mode="wait" initial={false}>
          {isRunning && (
            <motion.div
              key="dump-progress"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <chakra.div display="flex" flexDirection="column" gap="2">
                <chakra.div fontSize="sm" color="app.textMuted" display="flex" alignItems="center" gap="2">
                  {/* 数値はバー + タイルが示すので、文言は「ダンプ中…」だけにして重複させない。 */}
                  <chakra.span fontWeight={500} color="app.text">
                    {t("dumpRunning")}
                  </chakra.span>
                </chakra.div>
                {progress && <DumpProgressDetail progress={progress} running />}
              </chakra.div>
            </motion.div>
          )}
          {status.kind === "idle" && outcome && outcome.kind !== "error" && (
            <motion.div
              key="dump-outcome"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <DumpOutcome outcome={outcome} />
            </motion.div>
          )}
          {status.kind === "error" && (
            <motion.div
              key="dump-error"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <chakra.div display="flex" flexDirection="column" gap="2">
                {outcome?.kind === "error" && outcome.progress && (
                  <DumpProgressDetail progress={outcome.progress} tone="danger" />
                )}
                <ErrorNote>{t("dumpError", { error: status.message })}</ErrorNote>
              </chakra.div>
            </motion.div>
          )}
        </AnimatePresence>
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        {isRunning ? (
          <Button type="button" variant="secondary" onClick={handleCancelDump}>
            {t("dumpCancelRun")}
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("dumpCancel")}
          </Button>
        )}
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={isRunning}
          onClick={handleDump}
          disabled={isRunning || installing || !path.trim()}
        >
          {isRunning ? t("dumpRunning") : t("dumpExecute")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
