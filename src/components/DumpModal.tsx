import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, DumpOptions } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";

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
  | { kind: "success"; bytes: number; path: string }
  | { kind: "error"; message: string };

export function DumpModal({ sessionId, database, onClose }: Props) {
  const t = useT();
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
      setStatus({ kind: "success", bytes, path });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal export-modal dump-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>{t("dumpTitle", { database })}</h2>
          <button
            className="icon"
            onClick={onClose}
            aria-label={t("dumpClose")}
            title={t("dumpClose")}
          >
            ✕
          </button>
        </header>

        <div className="modal-body export-body">
          <div className="dump-note">{t("dumpNote")}</div>

          <section className="export-section">
            <div className="export-label">{t("dumpOptionsLabel")}</div>
            <div className="dump-options">
              {OPTION_ROWS.map((row) => (
                <label key={row.key} className="dump-option" title={t(row.hint)}>
                  <input
                    type="checkbox"
                    checked={options[row.key]}
                    onChange={() => toggle(row.key)}
                    disabled={isRunning}
                  />
                  <span className="dump-option-text">
                    <span className="dump-option-label">{t(row.label)}</span>
                    <span className="dump-option-hint">{t(row.hint)}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section className="export-section">
            <label className="export-label" htmlFor="dump-path">
              {t("dumpSavePath")}
            </label>
            <div className="export-path-row">
              <input
                id="dump-path"
                className="export-path-input"
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t("dumpSavePathPlaceholder")}
                disabled={isRunning}
              />
              <button type="button" onClick={handleBrowse} disabled={isRunning}>
                {t("dumpBrowse")}
              </button>
            </div>
          </section>

          {status.kind === "error" && (
            <div className="export-error">{t("dumpError", { error: status.message })}</div>
          )}
          {status.kind === "success" && (
            <div className="export-success">
              {t("dumpSuccess", { bytes: status.bytes, path: status.path })}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <div style={{ flex: 1 }} />
          <button onClick={onClose} disabled={isRunning}>
            {t("dumpCancel")}
          </button>
          <button
            className="primary"
            onClick={handleDump}
            disabled={isRunning || !path.trim()}
          >
            {isRunning ? t("dumpRunning") : t("dumpExecute")}
          </button>
        </div>
      </div>
    </div>
  );
}
