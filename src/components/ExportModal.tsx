import { useEffect, useMemo, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, CellValue, Column, ExportFormat } from "../api/tauri";
import { useT } from "../i18n";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input } from "./ui";
import { ErrorNote, FieldLabel, FormSection, PathRow } from "./modalForm";
import { useToast } from "./Toast";

interface Props {
  columns: Column[];
  rows: CellValue[][];
  database: string | null;
  table: string | null;
  /**
   * True when the grid holds only part of the result set (an auto LIMIT is
   * binding, or more pages can still be loaded). Surfaces a warning so the
   * user doesn't mistake a partial export for the full set.
   */
  partial?: boolean;
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
  // Replace characters that are unsafe across Windows/macOS/Linux filenames
  // with an underscore. Trim trailing dots/spaces (Windows quirk).
  return s
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
    .replace(/[ .]+$/, "")
    .trim();
}

function defaultBasename(database: string | null, table: string | null): string {
  const ts = timestamp();
  const schema = sanitizeForFilename(database ?? "");
  const tbl = sanitizeForFilename(table ?? "");
  if (schema && tbl) return `${schema}_${tbl}_${ts}`;
  if (schema) return `${schema}_query_${ts}`;
  if (tbl) return `${tbl}_${ts}`;
  return `query_${ts}`;
}

function extensionFor(format: ExportFormat): string {
  return format === "csv" ? ".csv" : ".json";
}

function replaceExtension(path: string, newExt: string): string {
  // Operate on the last segment so e.g. `C:\folder.with.dot\file.csv` works.
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return dir + stem + newExt;
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "error"; message: string };

export function ExportModal({ columns, rows, database, table, partial, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const initialBasename = useMemo(() => defaultBasename(database, table), [database, table]);
  const [path, setPath] = useState<string>(`${initialBasename}${extensionFor("csv")}`);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const isSaving = status.kind === "saving";

  // When the format changes, swap the extension on the current path. This
  // keeps the user's chosen directory but reflects the new format. If the
  // path is empty, just set the default.
  useEffect(() => {
    setPath((cur) => {
      if (!cur) return `${initialBasename}${extensionFor(format)}`;
      return replaceExtension(cur, extensionFor(format));
    });
    // intentionally exclude `initialBasename` so changing the timestamp
    // doesn't overwrite an in-progress path edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format]);

  const handleBrowse = async () => {
    const selected = await save({
      defaultPath: path || `${initialBasename}${extensionFor(format)}`,
      title: t("exportPickFileTitle"),
      filters: [
        format === "csv"
          ? { name: "CSV", extensions: ["csv"] }
          : { name: "JSON", extensions: ["json"] },
      ],
    });
    if (typeof selected === "string" && selected) {
      setPath(selected);
    }
  };

  const handleExport = async () => {
    if (!path.trim()) return;
    if (rows.length === 0) {
      setStatus({ kind: "error", message: t("exportNoData") });
      return;
    }
    setStatus({ kind: "saving" });
    try {
      const bytes = await api.exportQueryResult({ path, format, columns, rows });
      toast.success(t("exportSuccess", { bytes, path }));
      setStatus({ kind: "idle" });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
      toast.error(t("exportError", { error: String(e) }));
    }
  };

  return (
    <Modal
      width="560px"
      onClose={onClose}
      closeOnInteractOutside={!isSaving}
      closeOnEscape={!isSaving}
    >
      <ModalHeader onClose={onClose} closeLabel={t("exportClose")} closeDisabled={isSaving}>
        {t("exportTitle")}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="var(--space-4)">
        <chakra.div fontSize="md" color="app.text">
          {t("exportRowCount", { rows: rows.length })}
        </chakra.div>
        {partial && (
          <chakra.div
            role="status"
            p="8px 10px"
            border="1px solid"
            borderColor="color-mix(in srgb, #f59e0b 50%, var(--border))"
            bg="color-mix(in srgb, #f59e0b 14%, var(--bg-muted))"
            color="app.text"
            borderRadius="md"
            fontSize="sm"
            lineHeight={1.5}
          >
            {t("exportPartialWarning")}
          </chakra.div>
        )}
        <FormSection>
          <FieldLabel as="div">{t("exportFormat")}</FieldLabel>
          <chakra.div
            role="radiogroup"
            aria-label={t("exportFormat")}
            display="flex"
            gap="var(--space-2)"
          >
            {(["csv", "json"] as const).map((fmt) => (
              <chakra.label
                key={fmt}
                display="inline-flex"
                alignItems="center"
                gap="6px"
                p="6px 12px"
                border="1px solid"
                borderColor={format === fmt ? "app.accent" : "app.border"}
                borderRadius="md"
                fontSize="md"
                cursor="pointer"
                bg={format === fmt ? "app.rowHover" : "app.surface"}
                userSelect="none"
              >
                <input
                  type="radio"
                  name="export-format"
                  value={fmt}
                  checked={format === fmt}
                  onChange={() => setFormat(fmt)}
                  disabled={isSaving}
                  style={{ margin: 0 }}
                />
                <span>{fmt === "csv" ? t("exportFormatCsv") : t("exportFormatJson")}</span>
              </chakra.label>
            ))}
          </chakra.div>
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="export-path">{t("exportSavePath")}</FieldLabel>
          <PathRow>
            <Input
              id="export-path"
              flex="1"
              minW={0}
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t("exportSavePathPlaceholder")}
              disabled={isSaving}
            />
            <Button type="button" onClick={handleBrowse} disabled={isSaving}>
              {t("exportBrowse")}
            </Button>
          </PathRow>
        </FormSection>

        {status.kind === "error" && (
          <ErrorNote>{t("exportError", { error: status.message })}</ErrorNote>
        )}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" onClick={onClose} disabled={isSaving}>
          {t("exportCancel")}
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={handleExport}
          disabled={isSaving || !path.trim()}
        >
          {isSaving ? t("exportSaving") : t("exportExecute")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
