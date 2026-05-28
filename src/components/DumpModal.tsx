import { useMemo, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, DumpOptions } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, Switch } from "./ui";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { useToast } from "./Toast";

interface Props {
  sessionId: string;
  database: string;
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
};

/** Each toggle maps one checkbox to a `DumpOptions` field and its labels. */
const OPTION_ROWS: { key: keyof DumpOptions; label: I18nKey; hint: I18nKey }[] = [
  { key: "singleTransaction", label: "dumpOptSingleTransaction", hint: "dumpOptSingleTransactionHint" },
  { key: "routines", label: "dumpOptRoutines", hint: "dumpOptRoutinesHint" },
  { key: "events", label: "dumpOptEvents", hint: "dumpOptEventsHint" },
  { key: "triggers", label: "dumpOptTriggers", hint: "dumpOptTriggersHint" },
  { key: "addDropTable", label: "dumpOptAddDropTable", hint: "dumpOptAddDropTableHint" },
  { key: "extendedInsert", label: "dumpOptExtendedInsert", hint: "dumpOptExtendedInsertHint" },
  { key: "completeInsert", label: "dumpOptCompleteInsert", hint: "dumpOptCompleteInsertHint" },
  { key: "noData", label: "dumpOptNoData", hint: "dumpOptNoDataHint" },
  { key: "noCreateInfo", label: "dumpOptNoCreateInfo", hint: "dumpOptNoCreateInfoHint" },
];

type Status =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "error"; message: string };

export function DumpModal({ sessionId, database, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const initialBasename = useMemo(() => defaultBasename(database), [database]);
  const [path, setPath] = useState<string>(`${initialBasename}.sql`);
  const [options, setOptions] = useState<DumpOptions>(DEFAULT_OPTIONS);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const isRunning = status.kind === "running";

  const toggle = (key: keyof DumpOptions) =>
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

  const handleDump = async () => {
    if (!path.trim()) return;
    setStatus({ kind: "running" });
    try {
      const bytes = await api.dumpDatabase({ sessionId, database, path, options });
      toast.success(t("dumpSuccess", { bytes, path }));
      setStatus({ kind: "idle" });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
      toast.error(t("dumpError", { error: String(e) }));
    }
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

      <ModalBody display="flex" flexDirection="column" gap="var(--space-4)">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight={1.5}>
          {t("dumpNote")}
        </chakra.div>

        <FormSection>
          <FieldLabel as="div">{t("dumpOptionsLabel")}</FieldLabel>
          <chakra.div
            display="grid"
            gridTemplateColumns="repeat(auto-fill, minmax(240px, 1fr))"
            gap="6px 16px"
          >
            {OPTION_ROWS.map((row) => (
              <chakra.div
                key={row.key}
                display="flex"
                alignItems="flex-start"
                gap="var(--space-2)"
                py="4px"
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
                <chakra.span mt="2px" flex="none">
                  <Switch
                    checked={options[row.key]}
                    onChange={() => toggle(row.key)}
                    disabled={isRunning}
                    size="sm"
                  />
                </chakra.span>
                <chakra.span display="flex" flexDirection="column" gap="2px" minW={0}>
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

        {status.kind === "error" && (
          <ErrorNote>{t("dumpError", { error: status.message })}</ErrorNote>
        )}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose} disabled={isRunning}>
          {t("dumpCancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={handleDump}
          disabled={isRunning || !path.trim()}
        >
          {isRunning ? t("dumpRunning") : t("dumpExecute")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
