import { useEffect, useMemo, useRef, useState } from "react";
import { CellValue } from "../api/tauri";
import { useT } from "../i18n";
import { copyToClipboard } from "./clipboard";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Checkbox } from "./ui";

interface Props {
  /** Column name, shown in the modal header. */
  columnName: string;
  /** Raw cell value to display in full. */
  value: CellValue;
  /** True for binary columns — the value is a hex string shown with a 0x prefix. */
  isBinary?: boolean;
  onClose: () => void;
}

/** Pretty-print a string as JSON, or null when it isn't valid JSON. */
function tryFormatJson(s: string): string | null {
  const trimmed = s.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

export function CellValueViewer({ columnName, value, isBinary, onClose }: Props) {
  const t = useT();
  const isNull = value === null || value === undefined;
  const raw = isNull ? "" : isBinary ? `0x${String(value)}` : String(value);

  // JSON values are pretty-printed by default with a toggle back to raw text.
  const formattedJson = useMemo(
    () => (isNull || isBinary ? null : tryFormatJson(String(value))),
    [value, isNull, isBinary],
  );
  const canFormat = formattedJson !== null;
  const [pretty, setPretty] = useState(canFormat);
  const display = pretty && formattedJson !== null ? formattedJson : raw;

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    await copyToClipboard(display);
    setCopied(true);
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Modal width="820px" onClose={onClose}>
      <ModalHeader
        onClose={onClose}
        closeLabel={t("cellViewerClose")}
        titleProps={{ className: "cell-viewer-title", title: columnName }}
      >
        {columnName}
      </ModalHeader>

      <ModalBody className="cell-viewer-body">
        {isNull ? (
          <div className="cell-viewer-null">{t("resultNull")}</div>
        ) : display === "" ? (
          <div className="cell-viewer-null">{t("cellViewerEmpty")}</div>
        ) : (
          <pre className="cell-viewer-content">{display}</pre>
        )}
      </ModalBody>

      <ModalFooter>
        {canFormat && (
          <label className="cell-viewer-format-toggle">
            <Checkbox checked={pretty} onChange={(e) => setPretty(e.target.checked)} />
            <span>{t("cellViewerFormatJson")}</span>
          </label>
        )}
        <div className="cell-viewer-footer-spacer" />
        <Button type="button" onClick={handleCopy} disabled={isNull}>
          {copied ? t("gridCopied") : t("cellViewerCopy")}
        </Button>
        <Button type="button" variant="primary" onClick={onClose}>
          {t("cellViewerClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
