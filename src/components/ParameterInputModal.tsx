import { useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { DriverKind } from "../api/tauri";
import {
  extractQueryParams,
  findQuotedParams,
  isNumericParam,
  substituteQueryParams,
  type ParamType,
} from "../queryParams";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Callout } from "./Callout";
import { CodePreview, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton, Select } from "./ui";
import { Tooltip } from "./Tooltip";
import { isPlainEnterKey } from "./modalKeys";

/** Per-parameter draft: the typed value and how it's rendered into SQL. */
interface Draft {
  value: string;
  type: ParamType;
}

interface Props {
  /** SQL containing the `{{name}}` placeholders to resolve. */
  sql: string;
  /** Active session's driver, for escaping the preview / final SQL. */
  driver: DriverKind;
  /** Run with the entered values (App substitutes + executes). */
  onSubmit: (values: Record<string, string>, types: Record<string, ParamType>) => void;
  onCancel: () => void;
}

// 前回の「型」だけを記憶する。値は保存しない: `ALTER USER u IDENTIFIED BY {{pw}}` の
// ようにパスワードが入力されうるため、平文で localStorage に残さない (秘密は
// OS keyring のみ、という方針)。
const CACHE_KEY = "noobdb.queryparams.v1";
type Cache = Record<string, Draft>;

function readCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        // 旧版が保存した値は読み捨てる (型だけ使う)。
        const out: Cache = {};
        for (const [k, v] of Object.entries(parsed as Record<string, Partial<Draft>>)) {
          if (v && (v.type === "text" || v.type === "number" || v.type === "identifier")) {
            out[k] = { value: "", type: v.type };
          }
        }
        return out;
      }
    }
  } catch {
    // ignore (corrupt entry, private mode, quota)
  }
  return {};
}

function writeCache(next: Cache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

const TYPE_KEYS: { type: ParamType; key: Parameters<ReturnType<typeof useT>>[0] }[] = [
  { type: "text", key: "parameterInputTypeText" },
  { type: "number", key: "parameterInputTypeNumber" },
  { type: "identifier", key: "parameterInputTypeIdentifier" },
];

export function ParameterInputModal({ sql, driver, onSubmit, onCancel }: Props) {
  const t = useT();
  const names = useMemo(() => extractQueryParams(sql), [sql]);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const cache = readCache();
    const init: Record<string, Draft> = {};
    for (const n of names) init[n] = cache[n] ? { ...cache[n] } : { value: "", type: "text" };
    return init;
  });

  const setDraft = (name: string, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }));

  /** Validation error i18n key for one parameter, or null when acceptable. */
  const errorKey = (name: string): "parameterInputErrNumber" | "parameterInputErrRequired" | null => {
    const d = drafts[name];
    if (!d) return null;
    if (d.type === "number") return isNumericParam(d.value) ? null : "parameterInputErrNumber";
    // Identifiers can't be empty (an empty quoted identifier is invalid SQL).
    if (d.type === "identifier") return d.value.trim() === "" ? "parameterInputErrRequired" : null;
    return null; // text: any value (including empty) is allowed
  };

  // 引用符で囲んだプレースホルダ (数値型は引用符なしで入るので対象外)。
  const quotedNames = useMemo(() => findQuotedParams(sql, driver), [sql, driver]);
  const quotedWarnNames = quotedNames.filter((n) => (drafts[n]?.type ?? "text") !== "number");

  const hasError = names.some((n) => errorKey(n) !== null);

  const values = useMemo(() => {
    const v: Record<string, string> = {};
    for (const n of names) v[n] = drafts[n]?.value ?? "";
    return v;
  }, [names, drafts]);
  const types = useMemo(() => {
    const ty: Record<string, ParamType> = {};
    for (const n of names) ty[n] = drafts[n]?.type ?? "text";
    return ty;
  }, [names, drafts]);

  // Live preview of the exact SQL that will run, so the escaping is visible.
  const preview = useMemo(
    () => substituteQueryParams(sql, driver, values, types),
    [sql, driver, values, types],
  );

  const submit = () => {
    if (hasError) return;
    // 型だけ保存する (値は保存しない)。
    const typesOnly: Cache = {};
    for (const [n, d] of Object.entries(drafts)) typesOnly[n] = { value: "", type: d.type };
    writeCache({ ...readCache(), ...typesOnly });
    onSubmit(values, types);
  };

  return (
    <Modal
      onSubmit={submit}
      submitDisabled={hasError}
      width="600px"
      onClose={onCancel}
      initialFocusEl={() => firstInputRef.current}
    >
      <ModalHeader onClose={onCancel} closeLabel={t("parameterInputCancel")}>
        {t("parameterInputTitle")}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="3">
        <chakra.p m={0} color="app.textMuted" fontSize="sm">
          {t("parameterInputIntro")}
        </chakra.p>

        <chakra.div display="flex" flexDirection="column" gap="2">
          {names.map((name, idx) => {
            const d = drafts[name];
            const err = errorKey(name);
            return (
              <chakra.div
                key={name}
                display="grid"
                gridTemplateColumns="minmax(90px, 1fr) 120px minmax(0, 2fr)"
                gap="2"
                alignItems="center"
              >
                <Tooltip label={`{{${name}}}`}>
                  <chakra.code
                    fontSize="sm"
                    color="app.text"
                    whiteSpace="nowrap"
                    overflow="hidden"
                    textOverflow="ellipsis"
                  >{`{{${name}}}`}</chakra.code>
                </Tooltip>
                <Select
                  value={d?.type ?? "text"}
                  aria-label={t("parameterInputTypeLabelFor", { name })}
                  onChange={(e) => setDraft(name, { type: e.target.value as ParamType })}
                >
                  {TYPE_KEYS.map((o) => (
                    <option key={o.type} value={o.type}>
                      {t(o.key)}
                    </option>
                  ))}
                </Select>
                <chakra.div display="flex" flexDirection="column" gap="0.5" minWidth={0}>
                  <Input
                    ref={idx === 0 ? firstInputRef : undefined}
                    fontFamily="mono"
                    type="text"
                    inputMode={d?.type === "number" ? "decimal" : undefined}
                    value={d?.value ?? ""}
                    placeholder={t("parameterInputValuePlaceholder")}
                    aria-label={t("parameterInputValueLabelFor", { name })}
                    aria-invalid={err ? true : undefined}
                    onChange={(e) => setDraft(name, { value: e.target.value })}
                    onKeyDown={(e) => {
                      if (isPlainEnterKey(e)) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                  />
                  {err && <FieldError>{t(err)}</FieldError>}
                </chakra.div>
              </chakra.div>
            );
          })}
        </chakra.div>

        {quotedWarnNames.length > 0 && (
          <Callout tone="warning">
            {t("parameterInputQuotedWarning", { names: quotedWarnNames.map((n) => `{{${n}}}`).join(", ") })}
          </Callout>
        )}

        <FormSection>
          <FieldLabel as="div">{t("parameterInputPreviewLabel")}</FieldLabel>
          <CodePreview wrap maxH="160px">
            {preview}
          </CodePreview>
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("parameterInputEscapeNote")}
          </chakra.span>
        </FormSection>
      </ModalBody>

      <ModalFooter>
        {/* spacer → secondary (Cancel) → primary (Run) の右寄せ配置。他モーダルと統一 */}
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("parameterInputCancel")}
        </Button>
        <PressableButton type="button" variant="primary" onClick={submit} disabled={hasError}>
          {t("parameterInputRun")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
