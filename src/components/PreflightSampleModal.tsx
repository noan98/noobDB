import { useCallback } from "react";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { useRowSample } from "../useRowSample";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, FieldLabel, FormSection } from "./modalForm";
import { PREFLIGHT_SAMPLE_ROWS } from "./preflight";
import { RowSampleTable } from "./RowSampleTable";
import { Button } from "./ui";

/**
 * 影響行数プリフライトのバッジから開く、影響行の先頭数行のサンプル (#1626)。件数クエリと同じ WHERE の
 * 読み取り専用 SELECT なので `read_only` でも動き、実行前に「想定外の行が入っていないか」を目で確かめられる。
 */
export function PreflightSampleModal({
  sessionId,
  database,
  sampleSql,
  onClose,
}: {
  sessionId: string;
  database: string | null;
  sampleSql: string;
  onClose: () => void;
}) {
  const t = useT();
  const run = useCallback(
    (sql: string, rowCap: number) => api.runLookupQuery({ sessionId, sql, database, rowCap }),
    [sessionId, database],
  );
  // 開いた直後に 1 回だけ取得する (デバウンスは SQL が変わる場合のみ効く)。
  const state = useRowSample(run, sampleSql, PREFLIGHT_SAMPLE_ROWS);
  return (
    <Modal
      // no-submit: 閲覧専用のサンプル表示 (主アクションなし)
      width="720px"
      onClose={onClose}
    >
      <ModalHeader onClose={onClose} closeLabel={t("preflightSampleClose")}>
        {t("preflightSampleTitle", { count: PREFLIGHT_SAMPLE_ROWS })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="3">
        <FormSection>
          <FieldLabel as="div">{t("preflightSampleSql")}</FieldLabel>
          <CodePreview wrap maxH="120px">
            {sampleSql}
          </CodePreview>
        </FormSection>
        <RowSampleTable
          state={state}
          label={t("preflightSampleTitle", { count: PREFLIGHT_SAMPLE_ROWS })}
          testId="preflight-sample"
        />
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="primary" onClick={onClose}>
          {t("preflightSampleClose")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
