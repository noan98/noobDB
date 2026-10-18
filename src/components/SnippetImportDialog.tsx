import { useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { ProfileImportStrategy, SnippetImportPreview } from "../api/tauri";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FormSection, FieldLabel } from "./modalForm";
import { Button, PressableButton, Radio } from "./ui";

/**
 * スニペットのインポート確認ダイアログ (#1490)。ファイルを読んだあと、件数・ID 衝突件数・
 * スコープの付け替え・取り込めない要素を示し、衝突時の扱い (新規採番 / スキップ / 上書き)
 * を選んで確定する。衝突が無いときは戦略の選択を出さない。
 */
interface Props {
  preview: SnippetImportPreview;
  onConfirm: (strategy: ProfileImportStrategy) => Promise<void> | void;
  onCancel: () => void;
}

/** 「上書き」で置き換わる先として一覧に出す最大件数。 */
const OVERWRITE_PREVIEW_LIMIT = 5;

const Option = chakra("label", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "2",
    px: "2.5",
    py: "2",
    borderRadius: "var(--radius-lg)",
    cursor: "pointer",
    borderWidth: "1px",
    borderColor: "app.border",
    _hover: { bg: "app.rowHover" },
  },
});

export function SnippetImportDialog({ preview, onConfirm, onCancel }: Props) {
  const t = useT();
  const [strategy, setStrategy] = useState<ProfileImportStrategy>("rename");
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = !busy && preview.total > 0;
  // 衝突があって「上書き」を選んだときだけ、既存のスニペットが置き換わる破壊的な確定になる。
  const overwriting = strategy === "overwrite" && preview.conflict_count > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(strategy);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const options: { value: ProfileImportStrategy; label: string; desc: string }[] = [
    { value: "rename", label: t("snippetImportRename"), desc: t("snippetImportRenameDesc") },
    { value: "skip", label: t("snippetImportSkip"), desc: t("snippetImportSkipDesc") },
    { value: "overwrite", label: t("snippetImportOverwrite"), desc: t("snippetImportOverwriteDesc") },
  ];
  const rejectedDetail = preview.rejected
    .slice(0, 3)
    .map((r) => `${r.name ?? `#${r.index + 1}`}: ${r.error}`)
    .join(" / ");

  return (
    <Modal
      // no-submit: 既存スニペットを上書きしうる取り込みの確認。キャンセルが既定
      width="480px"
      onClose={onCancel}
      initialFocusEl={() => cancelRef.current}
    >
      <ModalHeader onClose={onCancel} closeLabel={t("confirmDefaultCancel")}>
        {t("snippetImportTitle")}
      </ModalHeader>
      <ModalBody>
        {preview.total === 0 ? (
          <Callout tone="warning" role="status">
            {t("snippetImportNothing")}
          </Callout>
        ) : (
          <chakra.p fontSize="sm" color="app.textSecondary" mb="3">
            {t("snippetImportSummary", {
              total: preview.total,
              fresh: preview.new_count,
              conflicts: preview.conflict_count,
            })}
          </chakra.p>
        )}
        {preview.scope_reset_count > 0 && (
          <Callout tone="info" role="status" mb="3">
            {t("snippetImportScopeReset", { count: preview.scope_reset_count })}
          </Callout>
        )}
        {preview.rejected.length > 0 && (
          <Callout tone="warning" role="status" mb="3">
            {t("snippetImportRejected", { count: preview.rejected.length, detail: rejectedDetail })}
          </Callout>
        )}
        {preview.total > 0 &&
          (preview.conflict_count === 0 ? (
            <chakra.p fontSize="sm" color="app.textMuted">
              {t("snippetImportNoConflicts")}
            </chakra.p>
          ) : (
            <FormSection>
              <FieldLabel as="div">{t("snippetImportConflictHeading")}</FieldLabel>
              <chakra.div display="flex" flexDirection="column" gap="2">
                {options.map((o) => (
                  <Option key={o.value} borderColor={strategy === o.value ? "app.accent" : "app.border"}>
                    <Radio
                      name="snippet-import-strategy"
                      checked={strategy === o.value}
                      onChange={() => setStrategy(o.value)}
                      mt="0.75"
                    />
                    <chakra.span display="flex" flexDirection="column">
                      <chakra.span textStyle="subheading">{o.label}</chakra.span>
                      <chakra.span textStyle="caption">{o.desc}</chakra.span>
                    </chakra.span>
                  </Option>
                ))}
              </chakra.div>
            </FormSection>
          ))}
        {overwriting && (
          <chakra.div mt="3" data-testid="snippet-import-overwrite-list">
            <FieldLabel as="div">{t("snippetImportOverwriteList")}</FieldLabel>
            <chakra.ul listStyleType="none" fontSize="sm" color="app.textSecondary" m="0" p="0">
              {preview.conflicts.slice(0, OVERWRITE_PREVIEW_LIMIT).map((c) => (
                <li key={c.id}>
                  {c.existing_name} → {c.incoming_name}
                </li>
              ))}
            </chakra.ul>
            {preview.conflict_count > OVERWRITE_PREVIEW_LIMIT && (
              <chakra.p textStyle="caption">
                {t("snippetImportOverwriteMore", {
                  count: preview.conflict_count - OVERWRITE_PREVIEW_LIMIT,
                })}
              </chakra.p>
            )}
          </chakra.div>
        )}
        {error && <ErrorNote mt="3">{t("snippetImportError", { error })}</ErrorNote>}
      </ModalBody>
      <ModalFooter>
        {overwriting ? (
          <>
            <Button type="button" variant="dangerOutline" disabled={!canSubmit} onClick={() => void submit()}>
              {t("snippetImportOverwriteConfirm")}
            </Button>
            <div style={{ flex: 1 }} />
            <Button ref={cancelRef} type="button" variant="primary" onClick={onCancel} disabled={busy}>
              {t("confirmDefaultCancel")}
            </Button>
          </>
        ) : (
          <>
            <div style={{ flex: 1 }} />
            <Button ref={cancelRef} type="button" variant="secondary" onClick={onCancel} disabled={busy}>
              {t("confirmDefaultCancel")}
            </Button>
            <PressableButton
              type="button"
              variant="primary"
              disabled={!canSubmit}
              onClick={() => void submit()}
            >
              {t("snippetImportConfirm")}
            </PressableButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
