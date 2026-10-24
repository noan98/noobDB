import { useMemo, useState } from "react";
import { chakra } from "@chakra-ui/react";
import type { RowKeyKind } from "../api/tauri";
import { useT } from "../i18n";
import { buildTimelapseDml, type TimelapseDmlDirection, type TimelapseExportRow } from "../tableTimelapse";
import { Callout } from "./Callout";
import { CopyButton } from "./CopyButton";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, FieldLabel, FormSection } from "./modalForm";
import { Button, Select } from "./ui";
import { useCopyFeedback } from "./useCopyFeedback";

interface Props {
  /** マスク前の値を持つ差分行 (`buildTimelapseExportRows(diff, null)`)。 */
  rows: readonly TimelapseExportRow[];
  maskedColumns: ReadonlySet<string>;
  driver: string;
  database: string;
  table: string;
  keyKind?: RowKeyKind;
  onClose: () => void;
}

/** プレビュー欄に出す最大行数 (コピーは全文が対象)。 */
const PREVIEW_LINES = 300;

/**
 * タイムラプスの世代間差分から、変更を再現する / 巻き戻す DML を組んでプレビュー・コピーする
 * モーダル (#1624)。**実行はしない** (実行する IPC を呼ばない)。置き場は Modal: 差分を見たあと
 * 生成結果を確認してコピーするだけの一時的な操作のため。
 */
export function TimelapseDmlModal({ rows, maskedColumns, driver, database, table, keyKind, onClose }: Props) {
  const t = useT();
  const { copied, copy } = useCopyFeedback();
  const [direction, setDirection] = useState<TimelapseDmlDirection>("revert");

  const result = useMemo(
    () =>
      buildTimelapseDml(rows, {
        driver,
        database,
        table,
        direction,
        maskedColumns,
        keyKind,
        header: t("timelapseDmlHeader"),
        skippedComment: (key) => t("timelapseDmlSkipped", { key }),
      }),
    [rows, driver, database, table, direction, maskedColumns, keyKind, t],
  );
  const lines = result.sql.split("\n");
  const preview =
    lines.length > PREVIEW_LINES
      ? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n-- ${t("timelapseDmlTruncated", { count: lines.length - PREVIEW_LINES })}`
      : result.sql;

  return (
    <Modal
      // no-submit: 生成した SQL を確認してコピーするだけの画面で、確定する主アクションが無い
      onClose={onClose}
      width="720px"
    >
      <ModalHeader onClose={onClose} closeLabel={t("timelapseDmlClose")}>
        {t("timelapseDmlTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="3">
        <Callout tone="info">{t("timelapseDmlNote")}</Callout>
        <FormSection>
          <FieldLabel htmlFor="timelapse-dml-direction">{t("timelapseDmlDirection")}</FieldLabel>
          <Select
            id="timelapse-dml-direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as TimelapseDmlDirection)}
          >
            <option value="revert">{t("timelapseDmlRevert")}</option>
            <option value="forward">{t("timelapseDmlForward")}</option>
          </Select>
        </FormSection>
        <FormSection>
          <chakra.div display="flex" alignItems="center" gap="2">
            <FieldLabel as="div" mb={0}>
              {t("timelapseDmlPreview", { count: result.statements })}
            </FieldLabel>
            <chakra.div flex="1" />
            <CopyButton
              copied={copied}
              onClick={() => void copy(result.sql)}
              disabled={result.statements === 0}
              focusableWrapper={result.statements === 0}
              label={t("exportCopyAll")}
              copiedLabel={t("gridCopied")}
              showLabel
              display="inline-flex"
              alignItems="center"
              gap="1.5"
              py="1"
              px="2"
              fontSize="xs"
            />
          </chakra.div>
          <CodePreview aria-label={t("timelapseDmlPreviewAria")} maxH="320px">
            {result.statements === 0 && result.skipped === 0 ? t("timelapseDmlEmpty") : preview}
          </CodePreview>
          {result.skipped > 0 && (
            <Callout tone="warning">{t("timelapseDmlSkippedNote", { count: result.skipped })}</Callout>
          )}
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <chakra.div flex="1" />
        <Button type="button" variant="primary" onClick={onClose}>
          {t("timelapseDmlClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
