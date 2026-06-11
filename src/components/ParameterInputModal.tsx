import { useMemo, useRef, useState } from "react";
import { Box, chakra, type SystemStyleObject } from "@chakra-ui/react";
import { useT } from "../i18n";
import type { DriverKind } from "../api/tauri";
import {
  extractQueryParams,
  isNumericParam,
  substituteQueryParams,
  type ParamType,
} from "../queryParams";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, PressableButton } from "./ui";

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

// Previously entered values/types persist across runs so repeating a
// parameterized query (or a saved snippet) doesn't re-type everything (#388).
const CACHE_KEY = "noobdb.queryparams.v1";
type Cache = Record<string, Draft>;

function readCache(): Cache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Cache;
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

const FIELD_CSS: SystemStyleObject = {
  padding: "5px 8px",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  _focus: {
    outline: "none",
    borderColor: "var(--accent)",
    boxShadow: "0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)",
  },
};

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
    // Persist every entered parameter for next time.
    writeCache({ ...readCache(), ...drafts });
    onSubmit(values, types);
  };

  return (
    <Modal width="600px" onClose={onCancel} initialFocusEl={() => firstInputRef.current}>
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
                <chakra.code
                  fontSize="sm"
                  color="app.text"
                  whiteSpace="nowrap"
                  overflow="hidden"
                  textOverflow="ellipsis"
                  title={`{{${name}}}`}
                >{`{{${name}}}`}</chakra.code>
                <chakra.select
                  css={FIELD_CSS}
                  value={d?.type ?? "text"}
                  aria-label={t("parameterInputTypeLabelFor", { name })}
                  onChange={(e) => setDraft(name, { type: e.target.value as ParamType })}
                >
                  {TYPE_KEYS.map((o) => (
                    <option key={o.type} value={o.type}>
                      {t(o.key)}
                    </option>
                  ))}
                </chakra.select>
                <chakra.div display="flex" flexDirection="column" gap="0.5" minWidth={0}>
                  <chakra.input
                    ref={idx === 0 ? firstInputRef : undefined}
                    css={FIELD_CSS}
                    type="text"
                    inputMode={d?.type === "number" ? "decimal" : undefined}
                    value={d?.value ?? ""}
                    placeholder={t("parameterInputValuePlaceholder")}
                    aria-label={t("parameterInputValueLabelFor", { name })}
                    aria-invalid={err ? true : undefined}
                    onChange={(e) => setDraft(name, { value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        submit();
                      }
                    }}
                  />
                  {err && (
                    <chakra.span fontSize="xs" color="app.textError" role="alert">
                      {t(err)}
                    </chakra.span>
                  )}
                </chakra.div>
              </chakra.div>
            );
          })}
        </chakra.div>

        <chakra.div display="flex" flexDirection="column" gap="3px">
          <chakra.span fontSize="xs" color="app.textMuted" fontWeight={600}>
            {t("parameterInputPreviewLabel")}
          </chakra.span>
          <Box
            as="pre"
            m={0}
            py="2"
            px="2.5"
            maxHeight="160px"
            overflow="auto"
            fontSize="sm"
            fontFamily="mono"
            color="app.text"
            bg="app.toolbar"
            border="1px solid"
            borderColor="app.border"
            borderRadius="md"
            whiteSpace="pre-wrap"
            wordBreak="break-word"
          >
            {preview}
          </Box>
          <chakra.span fontSize="xs" color="app.textMuted">
            {t("parameterInputEscapeNote")}
          </chakra.span>
        </chakra.div>
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
