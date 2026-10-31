import { useState } from "react";
import { chakra } from "@chakra-ui/react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api, type SqlEncodingPreview, type TextEncodingId } from "../api/tauri";
import { useT } from "../i18n";
import {
  LINE_ENDING_OPTIONS,
  parseLineEnding,
  parseTextEncodingId,
  textEncodingLabel,
  type LineEnding,
} from "../sqlFileIO";
import { Callout } from "./Callout";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { TextEncodingSelect } from "./TextEncodingSelect";
import { Button, PressableButton, Radio } from "./ui";
import { ListboxSelect } from "./ListboxSelect";

interface Props {
  /** `open` は読み込み (自動判定を含む)、`save` は保存。 */
  mode: "open" | "save";
  /** 保存の初期値 (タブが覚えている文字コード)。 */
  initial?: TextEncodingId;
  /** 保存の改行コードの初期値 (タブが覚えている値。無ければ LF、#1627)。 */
  initialLineEnding?: LineEnding;
  /** `null` は自動判定 (`open` のみ)。`lineEnding` は保存のときだけ意味を持つ。 */
  onConfirm: (encoding: TextEncodingId | null, lineEnding: LineEnding) => void;
  /** プレビューで選んだファイルを、選んだ文字コードで開く (`open` のみ、#1627)。 */
  onConfirmFile?: (path: string, encoding: TextEncodingId) => void;
  onClose: () => void;
}

/**
 * SQL ファイルを開く・保存するときの文字コード (と保存時の改行コード) を選ぶ小さなモーダル
 * (#1535)。ネイティブのファイルダイアログには選択欄を足せないため、ファイルを選ぶ前にここで
 * 決める。通常の「SQL ファイルを開く」「名前を付けて保存」は自動判定 / タブが覚えている
 * 値で動くので、このモーダルは上書きしたいときだけ出す (コマンドパレットから)。
 *
 * 開くときは「ファイルを選んでプレビュー」で、自動判定の結果と候補ごとの先頭数行を見比べて
 * 化けていない文字コードを選び直せる (#1627)。
 */
export function SqlFileEncodingModal({
  mode,
  initial,
  initialLineEnding,
  onConfirm,
  onConfirmFile,
  onClose,
}: Props) {
  const t = useT();
  const [value, setValue] = useState<string>(mode === "open" ? "" : (initial ?? "utf-8"));
  const [lineEnding, setLineEnding] = useState<string>(initialLineEnding ?? "lf");
  const [file, setFile] = useState<{ path: string; preview: SqlEncodingPreview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = async () => {
    setError(null);
    setBusy(true);
    try {
      const picked = await openFileDialog({
        multiple: false,
        title: t("openSqlFileTitle"),
        filters: [{ name: "SQL", extensions: ["sql", "txt"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      const preview = await api.previewSqlFileEncodings(picked);
      setFile({ path: picked, preview });
      // 既定は自動判定の結果、判定できなければ不正の無い最初の候補。
      const first = preview.detected ?? preview.candidates.find((c) => c.valid)?.encoding ?? null;
      setValue(first ?? "");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const selected = parseTextEncodingId(value);
  const confirm = () => {
    if (mode === "open" && file) {
      if (selected) onConfirmFile?.(file.path, selected);
      return;
    }
    onConfirm(selected, parseLineEnding(lineEnding) ?? "lf");
  };
  const primaryLabel =
    mode === "save"
      ? t("sqlFileEncodingSave")
      : file
        ? t("sqlFileEncodingOpenWith", { encoding: selected ? textEncodingLabel(selected) : "?" })
        : t("sqlFileEncodingOpen");

  return (
    <Modal onSubmit={confirm} width="560px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("sqlFileEncodingCancel")}>
        {mode === "open" ? t("sqlFileEncodingOpenTitle") : t("sqlFileEncodingSaveTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight="normal">
          {t("sqlFileEncodingNote")}
        </chakra.div>
        <FormSection>
          <FieldLabel htmlFor="sql-file-encoding">{t("sqlFileEncodingLabel")}</FieldLabel>
          <TextEncodingSelect
            id="sql-file-encoding"
            allowAuto={mode === "open"}
            value={value}
            onChange={setValue}
            css={{ width: "100%" }}
          />
        </FormSection>
        {mode === "save" && (
          <FormSection>
            <FieldLabel htmlFor="sql-file-line-ending">{t("sqlFileLineEndingLabel")}</FieldLabel>
            <ListboxSelect
              id="sql-file-line-ending"
              css={{ width: "100%" }}
              value={lineEnding}
              options={LINE_ENDING_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
              onChange={setLineEnding}
            />
            <chakra.div textStyle="caption">{t("sqlFileLineEndingNote")}</chakra.div>
          </FormSection>
        )}
        {mode === "open" && (
          <FormSection>
            <FieldLabel as="div">{t("sqlFileEncodingPreviewLabel")}</FieldLabel>
            <div>
              <Button type="button" variant="secondary" disabled={busy} onClick={() => void pickFile()}>
                {file ? t("sqlFileEncodingPreviewAgain") : t("sqlFileEncodingPreviewPick")}
              </Button>
            </div>
            {error && <ErrorNote>{error}</ErrorNote>}
            {file && (
              <EncodingCandidates
                preview={file.preview}
                value={value}
                onChange={setValue}
                fileName={file.path}
              />
            )}
          </FormSection>
        )}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("sqlFileEncodingCancel")}
        </Button>
        <PressableButton
          type="button"
          variant="primary"
          disabled={busy || (!!file && !selected)}
          onClick={confirm}
        >
          {primaryLabel}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}

/** 自動判定の結果と、候補ごとの先頭数行を並べて選ばせる (#1627)。 */
function EncodingCandidates({
  preview,
  value,
  onChange,
  fileName,
}: {
  preview: SqlEncodingPreview;
  value: string;
  onChange: (v: string) => void;
  fileName: string;
}) {
  const t = useT();
  return (
    <>
      {preview.detected ? (
        <Callout tone="info">
          {t("sqlFileEncodingDetected", { encoding: textEncodingLabel(preview.detected) })}
        </Callout>
      ) : (
        <Callout tone="warning">
          {t("sqlFileEncodingDetectFailed", { error: preview.detectError ?? "" })}
        </Callout>
      )}
      <chakra.div textStyle="caption" wordBreak="break-all">
        {fileName}
      </chakra.div>
      <chakra.div
        role="radiogroup"
        aria-label={t("sqlFileEncodingLabel")}
        display="flex"
        flexDirection="column"
        gap="2"
        maxH="280px"
        overflowY="auto"
      >
        {preview.candidates.map((c) => (
          <chakra.label key={c.encoding} display="flex" flexDirection="column" gap="1" cursor="pointer">
            <chakra.span display="inline-flex" alignItems="center" gap="1.5" fontSize="md">
              <Radio
                name="sql-file-encoding-candidate"
                value={c.encoding}
                checked={value === c.encoding}
                onChange={() => onChange(c.encoding)}
                m={0}
              />
              {textEncodingLabel(c.encoding)}
              {preview.detected === c.encoding && (
                <chakra.span textStyle="caption">{t("sqlFileEncodingDetectedBadge")}</chakra.span>
              )}
              {!c.valid && (
                <chakra.span color="app.textWarning" fontSize="xs">
                  {t("sqlFileEncodingInvalidBytes")}
                </chakra.span>
              )}
            </chakra.span>
            <CodePreview wrap maxH="96px" aria-label={textEncodingLabel(c.encoding)}>
              {c.lines.length > 0 ? c.lines.join("\n") : t("sqlFileEncodingPreviewEmpty")}
            </CodePreview>
          </chakra.label>
        ))}
      </chakra.div>
    </>
  );
}
