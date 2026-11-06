import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { save } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, DumpOptions, listenDumpStream, type DriverKind, type DumpToolStatus } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { transitions, variants } from "../motion";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, SelectableCard, Switch } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { CodePreview, ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { Callout } from "./Callout";
import { copyToClipboard } from "./clipboard";
import { Icon, ICON_SIZES } from "./Icon";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";
import { isAbsolutePath } from "./pathUtil";
import { dumpOptionLock, resolveDumpOptions, type DumpBoolOptionKey } from "../dumpOptionLocks";
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

const DEFAULT_OPTIONS: DumpOptions = {
  singleTransaction: true,
  routines: false,
  events: false,
  triggers: true,
  addDropTable: true,
  extendedInsert: true,
  completeInsert: false,
  noData: false,
  noCreateInfo: false,
  noOwner: true,
  noPrivileges: false,
  pgSchema: null,
  formatSql: false,
  gzip: false,
  noTablespaces: false,
  setGtidPurgedOff: false,
  writeChecksum: false,
  sqliteSnapshot: false,
  native: false,
};

type BoolOptionKey = DumpBoolOptionKey;

/** Each toggle maps one checkbox to a boolean `DumpOptions` field and its labels. */
const OPTION_ROWS: { key: BoolOptionKey; label: I18nKey; hint: I18nKey }[] = [
  { key: "singleTransaction", label: "dumpOptSingleTransaction", hint: "dumpOptSingleTransactionHint" },
  { key: "routines", label: "dumpOptRoutines", hint: "dumpOptRoutinesHint" },
  { key: "events", label: "dumpOptEvents", hint: "dumpOptEventsHint" },
  { key: "triggers", label: "dumpOptTriggers", hint: "dumpOptTriggersHint" },
  { key: "addDropTable", label: "dumpOptAddDropTable", hint: "dumpOptAddDropTableHint" },
  { key: "extendedInsert", label: "dumpOptExtendedInsert", hint: "dumpOptExtendedInsertHint" },
  { key: "completeInsert", label: "dumpOptCompleteInsert", hint: "dumpOptCompleteInsertHint" },
  { key: "noData", label: "dumpOptNoData", hint: "dumpOptNoDataHint" },
  { key: "noCreateInfo", label: "dumpOptNoCreateInfo", hint: "dumpOptNoCreateInfoHint" },
  { key: "noOwner", label: "dumpOptNoOwner", hint: "dumpOptNoOwnerHint" },
  { key: "noPrivileges", label: "dumpOptNoPrivileges", hint: "dumpOptNoPrivilegesHint" },
  { key: "formatSql", label: "dumpOptFormatSql", hint: "dumpOptFormatSqlHint" },
  { key: "gzip", label: "dumpOptGzip", hint: "dumpOptGzipHint" },
  { key: "noTablespaces", label: "dumpOptNoTablespaces", hint: "dumpOptNoTablespacesHint" },
  { key: "setGtidPurgedOff", label: "dumpOptGtidPurgedOff", hint: "dumpOptGtidPurgedOffHint" },
  { key: "writeChecksum", label: "dumpOptChecksum", hint: "dumpOptChecksumHint" },
  { key: "sqliteSnapshot", label: "dumpOptSqliteSnapshot", hint: "dumpOptSqliteSnapshotHint" },
];

/** オプションを「構造 / データ / 出力 / 互換」に分けて見せる (#2094)。 */
const OPTION_GROUPS: { id: string; label: I18nKey; keys: BoolOptionKey[] }[] = [
  {
    id: "structure",
    label: "dumpGroupStructure",
    keys: ["routines", "events", "triggers", "addDropTable", "noCreateInfo"],
  },
  {
    id: "data",
    label: "dumpGroupData",
    keys: ["singleTransaction", "extendedInsert", "completeInsert", "noData"],
  },
  { id: "output", label: "dumpGroupOutput", keys: ["formatSql", "gzip", "writeChecksum", "sqliteSnapshot"] },
  {
    id: "compat",
    label: "dumpGroupCompat",
    keys: ["noTablespaces", "setGtidPurgedOff", "noOwner", "noPrivileges"],
  },
];

/** Which toggle keys each driver shows. Omitted fields are sent at their default
 *  but hidden, so the wire shape stays a full `DumpOptions` for every driver. */
const DRIVER_OPTIONS: Record<DriverKind, BoolOptionKey[]> = {
  mysql: [
    "native",
    "singleTransaction",
    "routines",
    "events",
    "triggers",
    "addDropTable",
    "extendedInsert",
    "completeInsert",
    "noData",
    "noCreateInfo",
    "noTablespaces",
    "setGtidPurgedOff",
    "formatSql",
    "gzip",
    "writeChecksum",
  ],
  postgres: [
    "native",
    "routines",
    "addDropTable",
    "noData",
    "noCreateInfo",
    "noOwner",
    "noPrivileges",
    "formatSql",
    "gzip",
    "writeChecksum",
  ],
  sqlite: ["addDropTable", "noData", "noCreateInfo", "formatSql", "gzip", "writeChecksum", "sqliteSnapshot"],
};

/** 外部クライアントツールを使わずに接続から直接 SQL を生成するドライバ。 */
const NATIVE_DUMP_DRIVERS: ReadonlySet<DriverKind> = new Set<DriverKind>(["sqlite"]);

/** ドライバ → ダンプに使う外部ツール (SQLite は接続から直接生成するので無し)。 */
const DUMP_TOOL: Partial<Record<DriverKind, "mysqldump" | "pg_dump">> = {
  mysql: "mysqldump",
  postgres: "pg_dump",
};

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
  onUseNative,
  nativeSelected,
}: {
  status: DumpToolStatus;
  installing: boolean;
  installError: string | null;
  onInstall: () => void;
  /** ツールを入れずにネイティブ生成へ切り替える (#2033)。 */
  onUseNative: () => void;
  /** すでに内蔵生成を選んでいるときは「切り替える」ボタンを出さない。 */
  nativeSelected: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const plan = status.install;
  return (
    <Callout tone="warning" title={t("dumpToolMissingTitle", { tool: status.tool })}>
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
                  disabled={installing}
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
        {!nativeSelected && (
          <chakra.div display="flex" alignItems="center" gap="2" flexWrap="wrap">
            <Button type="button" size="sm" onClick={onUseNative}>
              {t("dumpUseNative")}
            </Button>
            <chakra.span textStyle="caption">{t("dumpUseNativeHint")}</chakra.span>
          </chakra.div>
        )}
        {installError && <ErrorNote>{t("dumpToolInstallFailed", { error: installError })}</ErrorNote>}
      </chakra.div>
    </Callout>
  );
}

type EngineBadgeTone = "accent" | "success" | "warning" | "muted";

/** エンジンカード / ロック行に付ける小さなラベル。 */
function EngineBadge({ tone, children }: { tone: EngineBadgeTone; children: ReactNode }) {
  const color =
    tone === "accent"
      ? "app.accent"
      : tone === "success"
        ? "app.textSuccess"
        : tone === "warning"
          ? "app.textWarning"
          : "app.textMuted";
  return (
    <chakra.span
      display="inline-flex"
      alignItems="center"
      px="1.5"
      border="1px solid"
      borderColor="currentColor"
      borderRadius="full"
      fontSize="xs"
      fontWeight={500}
      lineHeight={1.5}
      color={color}
      whiteSpace="nowrap"
    >
      {children}
    </chakra.span>
  );
}

/** 生成エンジンの選択カード (#2094)。利点と制約をカード内に出し、選べないときは理由を表示する。 */
function EngineCard({
  testId,
  selected,
  disabled,
  title,
  badge,
  desc,
  limits,
  disabledReason,
  onSelect,
}: {
  testId: string;
  selected: boolean;
  disabled: boolean;
  title: string;
  badge: ReactNode;
  desc: string;
  limits: string;
  disabledReason?: string | null;
  onSelect: () => void;
}) {
  return (
    <SelectableCard
      type="button"
      size="compact"
      flex="1 1 240px"
      aria-pressed={selected}
      disabled={disabled}
      data-testid={testId}
      onClick={onSelect}
    >
      <chakra.span display="flex" alignItems="center" gap="1.5" flexWrap="wrap">
        <chakra.span fontSize="md" fontWeight={600} color="app.text">
          {title}
        </chakra.span>
        {badge}
      </chakra.span>
      <chakra.span textStyle="caption" textAlign="left">
        {desc}
      </chakra.span>
      <chakra.span textStyle="caption" textAlign="left">
        {limits}
      </chakra.span>
      {disabledReason && (
        <chakra.span fontSize="xs" color="app.textWarning" lineHeight={1.4} textAlign="left">
          {disabledReason}
        </chakra.span>
      )}
    </SelectableCard>
  );
}

type Status = { kind: "idle" } | { kind: "running" } | { kind: "error"; message: string };

/** テーブル指定のダンプでは意味を持たない (テーブル指定時はバックエンドが無効にする) スイッチ。 */
const TABLE_SCOPE_HIDDEN_OPTIONS: ReadonlySet<BoolOptionKey> = new Set<BoolOptionKey>([
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
  const optionsIdBase = `dump-opt-${useId().replace(/:/g, "")}`;
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
    const base = { ...DEFAULT_OPTIONS, ...remembered?.options };
    // PostgreSQL のツリーの「database」はスキーマ。スキーマノードからの全体ダンプは、タイトルの範囲と
    // 揃えるためスキーマ欄を初期入力する (一括 = tables 指定は送信時に database で固定される)。
    return driver === "postgres" && !(tables && tables.length > 0) ? { ...base, pgSchema: database } : base;
  });
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [progress, setProgress] = useState<DumpProgress | null>(null);
  // Active dump's stream id + event unlistener, so the modal can cancel and
  // clean up its subscription (#686).
  const streamIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  // ダンプ用の外部ツールがこの PC にあるか (SQLite は不要なので null のまま)。
  const toolName = DUMP_TOOL[driver] ?? null;
  const [toolStatus, setToolStatus] = useState<DumpToolStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const refreshToolStatus = useMemo(
    () => async () => {
      if (!toolName) return;
      try {
        setToolStatus(await api.dumpToolStatus(toolName));
      } catch {
        // 検出自体の失敗は致命的ではない (実行時のエラーで分かる) ので黙って続ける。
        setToolStatus(null);
      }
    },
    [toolName],
  );
  useEffect(() => {
    void refreshToolStatus();
  }, [refreshToolStatus]);
  // ネイティブ生成 (#2033) を選ぶと外部ツールは使わない (SQLite は元から不要)。
  const useNative = NATIVE_DUMP_DRIVERS.has(driver) || !!options.native;
  const toolMissing = !useNative && !!toolStatus && toolStatus.path == null;

  const handleInstallTool = async () => {
    if (!toolName) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const next = await api.installDumpTool(toolName);
      setToolStatus(next);
      setStatus({ kind: "idle" });
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
  const visibleRows = useMemo(() => {
    const allowed = new Set(DRIVER_OPTIONS[driver]);
    return OPTION_ROWS.filter(
      (row) => allowed.has(row.key) && !(tableScope && TABLE_SCOPE_HIDDEN_OPTIONS.has(row.key)),
    );
  }, [driver, tableScope]);
  const rowByKey = useMemo(() => new Map(visibleRows.map((row) => [row.key, row])), [visibleRows]);

  // 生成エンジンを選べるのは外部ツールのあるドライバだけ (SQLite は常に内蔵)。
  const engineSelectable = !NATIVE_DUMP_DRIVERS.has(driver);
  // 効かないオプションの判定。画面 (無効 + 理由) と実行時の値の上書きが同じ文脈を使う (#2094)。
  const lockCtx = { driver, native: !!options.native, sqliteSnapshot: !!options.sqliteSnapshot };
  const lockOf = (key: BoolOptionKey) => dumpOptionLock(key, lockCtx);

  /** 生成エンジンを選ぶ。PostgreSQL のネイティブ生成は、トリガーが参照する関数を出さないと復元できないので、
   *  内蔵に切り替えたときルーチンも既定でオンにする。 */
  const selectEngine = (native: boolean) => {
    if (isRunning) return;
    setOptions((prev) => ({
      ...prev,
      native,
      ...(native && !prev.native && driver === "postgres" ? { routines: true } : {}),
    }));
  };

  const toggle = (key: BoolOptionKey) => {
    if (lockOf(key)) return;
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
          (k) => [k, options[k] === true],
        ),
      ) as Partial<Record<DumpBoolKey, boolean>>,
      dir: dirnameOf(target),
    });
    const resolved = resolveDumpOptions(options, lockCtx);
    const streamId = makeDumpStreamId();
    streamIdRef.current = streamId;
    setStatus({ kind: "running" });
    setProgress(null);

    try {
      // Subscribe before starting so no early progress event is missed. Both the
      // subscription and the kick-off are in this try/catch so a failure in
      // either can't leave the modal stuck in the "running" state.
      unlistenRef.current = await listenDumpStream(streamId, {
        onProgress: (e) =>
          setProgress({
            bytes: e.bytes,
            elapsedMs: e.elapsedMs,
            tables: e.tables,
            tablesTotal: e.tablesTotal,
          }),
        onDone: (e) => {
          cleanupStream();
          toast.success(t("dumpSuccess", { bytes: e.bytes, path: target }));
          setStatus({ kind: "idle" });
          setProgress(null);
        },
        onError: (e) => {
          cleanupStream();
          setStatus({ kind: "error", message: e.error });
          // ツールが見つからない失敗なら、導入の案内を出すために検出し直す。
          void refreshToolStatus();
          toast.error(t("dumpError", { error: e.error }));
          setProgress(null);
        },
        onCancelled: () => {
          cleanupStream();
          setStatus({ kind: "idle" });
          setProgress(null);
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
          <FormSection>
            <FieldLabel as="div">{t("dumpEngineLabel")}</FieldLabel>
            <chakra.div display="flex" flexWrap="wrap" gap="2" role="group" aria-label={t("dumpEngineLabel")}>
              <EngineCard
                testId="dump-engine-native"
                selected={useNative}
                disabled={isRunning}
                title={t("dumpEngineNativeTitle")}
                badge={<EngineBadge tone="accent">{t("dumpEngineRecommended")}</EngineBadge>}
                desc={t("dumpEngineNativeDesc")}
                limits={t("dumpEngineNativeLimits")}
                onSelect={() => selectEngine(true)}
              />
              <EngineCard
                testId="dump-engine-external"
                selected={!useNative}
                disabled={isRunning || toolMissing}
                title={t("dumpEngineExternalTitle", { tool: toolName })}
                badge={
                  toolStatus ? (
                    <EngineBadge tone={toolStatus.path ? "success" : "warning"}>
                      {toolStatus.path ? t("dumpEngineToolFound") : t("dumpEngineToolMissing")}
                    </EngineBadge>
                  ) : null
                }
                desc={t("dumpEngineExternalDesc", { tool: toolName })}
                limits={t("dumpEngineExternalLimits", { tool: toolName })}
                disabledReason={toolMissing ? t("dumpEngineExternalDisabled", { tool: toolName }) : null}
                onSelect={() => selectEngine(false)}
              />
            </chakra.div>
          </FormSection>
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
                onUseNative={() => selectEngine(true)}
                nativeSelected={useNative}
              />
            </motion.div>
          )}
        </AnimatePresence>
        {!useNative && toolStatus?.path && (
          <chakra.div fontSize="xs" color="app.textMuted" wordBreak="break-all">
            {t("dumpToolFound", { tool: toolStatus.tool, path: toolStatus.path })}
          </chakra.div>
        )}

        {OPTION_GROUPS.map((group) => {
          const rows = group.keys.map((k) => rowByKey.get(k)).filter((r): r is NonNullable<typeof r> => !!r);
          if (rows.length === 0) return null;
          return (
            <FormSection key={group.id} data-testid={`dump-group-${group.id}`}>
              <FieldLabel as="div">{t(group.label)}</FieldLabel>
              <chakra.div
                display="grid"
                gridTemplateColumns="repeat(auto-fill, minmax(240px, 1fr))"
                rowGap="1.5"
                columnGap="4"
              >
                {rows.map((row) => {
                  const lock = lockOf(row.key);
                  const reason = lock ? t(lock.reason) : null;
                  return (
                    <Tooltip key={row.key} label={reason ?? t(row.hint)}>
                      <chakra.div
                        display="flex"
                        alignItems="flex-start"
                        gap="2"
                        py="1"
                        cursor={isRunning || lock ? "not-allowed" : "pointer"}
                        userSelect="none"
                        data-locked={lock ? "true" : undefined}
                        onClick={(e) => {
                          if (isRunning || lock) return;
                          // Switch 自身のクリックはコンポーネント側で処理されるので、
                          // ラッパーは text 部分のクリックだけを引き受ける。
                          if (e.target instanceof HTMLElement && e.target.closest("button[role=switch]")) {
                            return;
                          }
                          toggle(row.key);
                        }}
                      >
                        <chakra.span mt="0.5" flex="none">
                          <Switch
                            checked={lock ? lock.forced : !!options[row.key]}
                            onChange={() => toggle(row.key)}
                            disabled={isRunning || !!lock}
                            size="sm"
                            aria-labelledby={`${optionsIdBase}-${row.key}-label`}
                            aria-describedby={`${optionsIdBase}-${row.key}-hint`}
                          />
                        </chakra.span>
                        <chakra.span display="flex" flexDirection="column" gap="0.5" minW={0}>
                          <chakra.span display="flex" alignItems="center" gap="1.5" flexWrap="wrap">
                            <chakra.span
                              id={`${optionsIdBase}-${row.key}-label`}
                              fontSize="md"
                              color={lock ? "app.textMuted" : "app.text"}
                            >
                              {t(row.label)}
                            </chakra.span>
                            {lock && <EngineBadge tone="muted">{t("dumpLockBadge")}</EngineBadge>}
                          </chakra.span>
                          <chakra.span
                            id={`${optionsIdBase}-${row.key}-hint`}
                            fontSize="xs"
                            color={lock ? "app.textWarning" : "app.textMuted"}
                            lineHeight={1.4}
                          >
                            {reason ?? t(row.hint)}
                          </chakra.span>
                        </chakra.span>
                      </chakra.div>
                    </Tooltip>
                  );
                })}
              </chakra.div>
            </FormSection>
          );
        })}
        {driver === "postgres" && !tableScope && (
          <FormSection>
            <chakra.div display="flex" flexDirection="column" gap="1">
              <FieldLabel htmlFor="dump-pg-schema">{t("dumpOptPgSchema")}</FieldLabel>
              <Input
                id="dump-pg-schema"
                type="text"
                value={options.pgSchema ?? ""}
                onChange={(e) => setOptions((prev) => ({ ...prev, pgSchema: e.target.value || null }))}
                placeholder={t("dumpOptPgSchemaPlaceholder")}
                disabled={isRunning}
              />
              <chakra.span fontSize="xs" color="app.textMuted">
                {t("dumpOptPgSchemaHint")}
              </chakra.span>
            </chakra.div>
          </FormSection>
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
              <chakra.div fontSize="sm" color="app.textMuted" display="flex" alignItems="center" gap="2">
                <chakra.span fontWeight={500} color="app.text">
                  {progress
                    ? progress.tablesTotal != null
                      ? t("dumpProgressTables", {
                          tables: progress.tables ?? 0,
                          total: progress.tablesTotal,
                          bytes: formatBytes(progress.bytes),
                        })
                      : t("dumpProgressBytes", { bytes: formatBytes(progress.bytes) })
                    : t("dumpRunning")}
                </chakra.span>
                {progress && (
                  <chakra.span opacity={0.8}>
                    {t("dumpProgressElapsed", {
                      secs: (progress.elapsedMs / 1000).toFixed(1),
                    })}
                  </chakra.span>
                )}
              </chakra.div>
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
              <ErrorNote>{t("dumpError", { error: status.message })}</ErrorNote>
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
