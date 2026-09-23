import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { useT } from "../i18n";
import { api, type DriverKind, type RoutineSignature } from "../api/tauri";
import {
  buildRoutineCall,
  routineParamIsArgument,
  routineParamTakesInput,
  validateRoutineInput,
} from "./routineCall";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Button, Input, PressableButton } from "./ui";

/**
 * ストアドプロシージャ / 関数の「実行…」フォーム (#1003)。
 *
 * シグネチャを `get_routine_signature` で取得して型別の入力欄を並べ、
 * `routineCall.ts` が組み立てた呼び出し SQL をプレビューする。実行は親
 * (`App.tsx`) が通常のクエリ実行ゲート (危険クエリ確認・confirm_writes →
 * `run_query_stream`) に渡すので、このモーダル自体は SQL を実行しない。
 */
interface Props {
  sessionId: string;
  driver: DriverKind;
  database: string;
  kind: "procedure" | "function";
  name: string;
  /** PostgreSQL の oid (オーバーロード解決用)。 */
  id: string | null;
  /** 明示的トランザクション中か (MySQL の OUT / INOUT は固定接続が必要)。 */
  txActive: boolean;
  onRun: (sql: string) => void;
  onSendToEditor: (sql: string) => void;
  onCancel: () => void;
}

export function RunRoutineModal({
  sessionId,
  driver,
  database,
  kind,
  name,
  id,
  txActive,
  onRun,
  onSendToEditor,
  onCancel,
}: Props) {
  const t = useT();
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [signature, setSignature] = useState<RoutineSignature | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    api
      .getRoutineSignature(sessionId, database, kind, name, id)
      .then((sig) => {
        if (!alive) return;
        setSignature(sig);
        setValues(sig.parameters.map(() => ""));
      })
      .catch((e) => {
        if (alive) setLoadError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [sessionId, database, kind, name, id]);

  const errors = useMemo(
    () => (signature ? signature.parameters.map((p, i) => validateRoutineInput(p, values[i] ?? "")) : []),
    [signature, values],
  );
  const hasError = errors.some((e) => e !== null);

  const call = useMemo(
    () => (signature ? buildRoutineCall({ driver, database, signature, values }) : null),
    [driver, database, signature, values],
  );
  // MySQL の OUT / INOUT はセッション変数を文をまたいで読むため、接続が固定される
  // 明示的トランザクション中でしか正しく実行できない。それ以外は実行を止めて
  // 「エディタへ送る」だけを許す (黙って空の OUT 値を見せない)。
  const blockedBySession = !!call?.needsSameConnection && !txActive;
  const canRun = !!call && !hasError && !blockedBySession;

  const run = () => {
    if (canRun && call) onRun(call.sql);
  };

  const args = signature ? signature.parameters.filter(routineParamIsArgument) : [];
  const title = t(kind === "procedure" ? "runRoutineTitleProcedure" : "runRoutineTitleFunction", {
    name,
  });

  return (
    <Modal width="640px" onClose={onCancel} initialFocusEl={() => firstInputRef.current}>
      <ModalHeader onClose={onCancel} closeLabel={t("runRoutineCancel")}>
        {title}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="3">
        {loadError && <ErrorNote role="alert">{t("runRoutineLoadError", { error: loadError })}</ErrorNote>}
        {!signature && !loadError && (
          <chakra.p m={0} color="app.textMuted" fontSize="sm">
            {t("runRoutineLoading")}
          </chakra.p>
        )}
        {signature && (
          <>
            <chakra.p m={0} color="app.textMuted" fontSize="sm">
              {signature.return_type
                ? t("runRoutineIntroReturns", { type: signature.return_type })
                : t("runRoutineIntro")}
            </chakra.p>
            {args.length === 0 && (
              <chakra.p m={0} color="app.textMuted" fontSize="sm">
                {t("runRoutineNoParams")}
              </chakra.p>
            )}
            {args.map((p, argIdx) => {
              const i = signature.parameters.indexOf(p);
              const inputId = `run-routine-param-${i}`;
              const takesInput = routineParamTakesInput(p);
              const err = errors[i];
              const label = p.name || t("runRoutineUnnamedParam", { n: i + 1 });
              return (
                <FormSection key={inputId}>
                  <FieldLabel htmlFor={inputId}>
                    {label} · {p.mode.toUpperCase()} · {p.data_type}
                  </FieldLabel>
                  <Input
                    id={inputId}
                    ref={argIdx === 0 ? firstInputRef : undefined}
                    fontFamily="mono"
                    value={takesInput ? (values[i] ?? "") : ""}
                    disabled={!takesInput}
                    placeholder={takesInput ? t("runRoutineValuePlaceholder") : t("runRoutineOutPlaceholder")}
                    aria-invalid={err ? true : undefined}
                    onChange={(e) => {
                      const v = e.target.value;
                      setValues((prev) => prev.map((old, j) => (j === i ? v : old)));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        run();
                      }
                    }}
                  />
                  {err && <FieldError>{t(err)}</FieldError>}
                </FormSection>
              );
            })}
            {call && (
              <FormSection>
                <FieldLabel as="div">{t("runRoutinePreviewLabel")}</FieldLabel>
                <CodePreview wrap maxH="200px">
                  {call.sql}
                </CodePreview>
                <chakra.span fontSize="xs" color="app.textMuted">
                  {t("runRoutineEscapeNote")}
                </chakra.span>
                {!call.outputsReturned && (
                  <chakra.span fontSize="xs" color="app.textWarning">
                    {t("runRoutineOutputsNotReturned")}
                  </chakra.span>
                )}
              </FormSection>
            )}
            {blockedBySession && <ErrorNote role="alert">{t("runRoutineNeedsTransaction")}</ErrorNote>}
          </>
        )}
      </ModalBody>

      <ModalFooter>
        <Button
          type="button"
          variant="secondary"
          disabled={!call || hasError}
          onClick={() => call && onSendToEditor(call.sql)}
        >
          {t("runRoutineSendToEditor")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("runRoutineCancel")}
        </Button>
        <PressableButton type="button" variant="primary" onClick={run} disabled={!canRun}>
          {t("runRoutineRun")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
