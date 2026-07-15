import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { save } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, DumpOptions, listenDumpStream, type DriverKind } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, Switch } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { useToast } from "./Toast";

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

  // Detach the event subscription if the modal unmounts mid-dump.
  useEffect(
    () => () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
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

    // Subscribe before starting so no early progress event is missed.
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

    try {
      await api.dumpDatabase({ sessionId, streamId, database, path, options });
    } catch (e) {
      // Kick-off (validation) failure — terminal events never fire in this case.
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
          {t("dumpNote")}
        </chakra.div>

        <FormSection>
          <FieldLabel as="div">{t("dumpOptionsLabel")}</FieldLabel>
          <chakra.div
            display="grid"
            gridTemplateColumns="repeat(auto-fill, minmax(240px, 1fr))"
            rowGap="1.5" columnGap="4"
          >
            {visibleRows.map((row) => (
              <chakra.div
                key={row.key}
                display="flex"
                alignItems="flex-start"
                gap="2"
                py="1"
                cursor={isRunning ? "not-allowed" : "pointer"}
                userSelect="none"
                title={t(row.hint)}
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

        {isRunning && (
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
        )}

        {status.kind === "error" && (
          <ErrorNote>{t("dumpError", { error: status.message })}</ErrorNote>
        )}
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
          disabled={isRunning || !path.trim()}
        >
          {isRunning ? t("dumpRunning") : t("dumpExecute")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
