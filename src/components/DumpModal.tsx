import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { save } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, DumpOptions, listenDumpStream, type DriverKind, type DumpToolStatus } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { transitions, variants } from "../motion";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, Switch } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { CodePreview, ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { Callout } from "./Callout";
import { copyToClipboard } from "./clipboard";
import { Icon, ICON_SIZES } from "./Icon";
import { useToast } from "./Toast";
import { Tooltip } from "./Tooltip";

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

function defaultBasename(database: string): string {
  const schema = sanitizeForFilename(database) || "database";
  return `${schema}_dump_${timestamp()}`;
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
};

type BoolOptionKey = {
  [K in keyof DumpOptions]-?: DumpOptions[K] extends boolean | undefined ? K : never;
}[keyof DumpOptions];

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
];

/** Which toggle keys each driver shows. Omitted fields are sent at their default
 *  but hidden, so the wire shape stays a full `DumpOptions` for every driver. */
const DRIVER_OPTIONS: Record<DriverKind, BoolOptionKey[]> = {
  mysql: [
    "singleTransaction",
    "routines",
    "events",
    "triggers",
    "addDropTable",
    "extendedInsert",
    "completeInsert",
    "noData",
    "noCreateInfo",
    "formatSql",
  ],
  postgres: ["addDropTable", "noData", "noCreateInfo", "noOwner", "noPrivileges", "formatSql"],
  sqlite: ["addDropTable", "noData", "noCreateInfo", "formatSql"],
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
}: {
  status: DumpToolStatus;
  installing: boolean;
  installError: string | null;
  onInstall: () => void;
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
        {installError && <ErrorNote>{t("dumpToolInstallFailed", { error: installError })}</ErrorNote>}
      </chakra.div>
    </Callout>
  );
}

type Status =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error"; message: string };

export function DumpModal({ sessionId, database, driver, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const initialBasename = useMemo(() => defaultBasename(database), [database]);
  const [path, setPath] = useState<string>(`${initialBasename}.sql`);
  const [options, setOptions] = useState<DumpOptions>(DEFAULT_OPTIONS);
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
  const toolMissing = !!toolStatus && toolStatus.path == null;

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
    return OPTION_ROWS.filter((row) => allowed.has(row.key));
  }, [driver]);

  const toggle = (key: BoolOptionKey) =>
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleBrowse = async () => {
    const selected = await save({
      defaultPath: path || `${initialBasename}.sql`,
      title: t("dumpPickFileTitle"),
      filters: [{ name: "SQL", extensions: ["sql"] }],
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
    if (!path.trim()) return;
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
          toast.success(t("dumpSuccess", { bytes: e.bytes, path }));
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

      await api.dumpDatabase({ sessionId, streamId, database, path, options });
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
      width="620px"
      onClose={onClose}
      closeOnInteractOutside={!isRunning}
      closeOnEscape={!isRunning}
    >
      <ModalHeader onClose={onClose} closeLabel={t("dumpClose")} closeDisabled={isRunning}>
        {t("dumpTitle", { database })}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight={1.5}>
          {NATIVE_DUMP_DRIVERS.has(driver) ? t("dumpNoteNative") : t("dumpNote", { tool: toolName ?? "mysqldump" })}
        </chakra.div>

        {toolStatus && toolMissing && (
          <DumpToolNotice
            status={toolStatus}
            installing={installing}
            installError={installError}
            onInstall={() => void handleInstallTool()}
          />
        )}
        {toolStatus?.path && (
          <chakra.div fontSize="xs" color="app.textMuted" wordBreak="break-all">
            {t("dumpToolFound", { tool: toolStatus.tool, path: toolStatus.path })}
          </chakra.div>
        )}

        <FormSection>
          <FieldLabel as="div">{t("dumpOptionsLabel")}</FieldLabel>
          <chakra.div
            display="grid"
            gridTemplateColumns="repeat(auto-fill, minmax(240px, 1fr))"
            rowGap="1.5" columnGap="4"
          >
            {visibleRows.map((row) => (
              <Tooltip key={row.key} label={t(row.hint)}>
                <chakra.div
                  display="flex"
                  alignItems="flex-start"
                  gap="2"
                  py="1"
                  cursor={isRunning ? "not-allowed" : "pointer"}
                  userSelect="none"
                  onClick={(e) => {
                    if (isRunning) return;
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
                      checked={!!options[row.key]}
                      onChange={() => toggle(row.key)}
                      disabled={isRunning}
                      size="sm"
                    />
                  </chakra.span>
                  <chakra.span display="flex" flexDirection="column" gap="0.5" minW={0}>
                    <chakra.span fontSize="md" color="app.text">
                      {t(row.label)}
                    </chakra.span>
                    <chakra.span fontSize="xs" color="app.textMuted" lineHeight={1.4}>
                      {t(row.hint)}
                    </chakra.span>
                  </chakra.span>
                </chakra.div>
              </Tooltip>
            ))}
          </chakra.div>
          {driver === "postgres" && (
            <chakra.div mt="2.5" display="flex" flexDirection="column" gap="1">
              <FieldLabel htmlFor="dump-pg-schema">{t("dumpOptPgSchema")}</FieldLabel>
              <Input
                id="dump-pg-schema"
                type="text"
                value={options.pgSchema ?? ""}
                onChange={(e) =>
                  setOptions((prev) => ({ ...prev, pgSchema: e.target.value || null }))
                }
                placeholder={t("dumpOptPgSchemaPlaceholder")}
                disabled={isRunning}
              />
              <chakra.span fontSize="xs" color="app.textMuted">
                {t("dumpOptPgSchemaHint")}
              </chakra.span>
            </chakra.div>
          )}
        </FormSection>

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
              <chakra.div
                fontSize="sm"
                color="app.textMuted"
                display="flex"
                alignItems="center"
                gap="2"
              >
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
