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
import { isPlainEnterKey } from "./modalKeys";
import { Button, Input, PressableButton, Select } from "./ui";
import { useSettings } from "../settings";
import {
  describeArgSet,
  fitArgSet,
  loadRoutineArgSets,
  pushRoutineArgSet,
  routineArgsScope,
  saveRoutineArgSets,
} from "../inputMemory";

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
  /** 接続プロファイル ID。直近の引数セットをルーチンごとに (アプリ起動中だけ) 覚える (#1631)。 */
  profileId?: string;
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
  profileId,
  onRun,
  onSendToEditor,
  onCancel,
}: Props) {
  const t = useT();
  const maskPatterns = useSettings().columnMaskPatterns;
  // 直近に使った引数セット (#1631)。値に機微な情報が入りうるので、ディスクには書かず、アプリ起動中の
  // メモリだけに持つ。引数名がマスク対象に一致する引数は覚えない。
  const argScope = routineArgsScope(profileId, database, kind, name, id);
  const [argHistory, setArgHistory] = useState(() => loadRoutineArgSets(argScope));
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

  /** 実行 / エディタへ送る直前に、今回の引数セットを履歴の先頭へ足す。 */
  const rememberArgs = () => {
    if (!signature) return;
    const next = pushRoutineArgSet(
      argHistory,
      signature.parameters.map((p, i) => (routineParamTakesInput(p) ? (values[i] ?? "") : "")),
      signature.parameters.map((p) => p.name),
      maskPatterns,
    );
    setArgHistory(next);
    saveRoutineArgSets(argScope, next);
  };

  const run = () => {
    if (canRun && call) {
      rememberArgs();
      onRun(call.sql);
    }
  };

  const args = signature ? signature.parameters.filter(routineParamIsArgument) : [];
  const title = t(kind === "procedure" ? "runRoutineTitleProcedure" : "runRoutineTitleFunction", {
    name,
  });

  return (
    <Modal
      onSubmit={run}
      submitDisabled={!canRun}
      width="640px"
      onClose={onCancel}
      initialFocusEl={() => firstInputRef.current}
    >
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
            {args.length > 0 && argHistory.length > 0 && (
              <FormSection>
                <FieldLabel htmlFor="run-routine-history">{t("runRoutineHistoryLabel")}</FieldLabel>
                <Select
                  id="run-routine-history"
                  value=""
                  onChange={(e) => {
                    const set = argHistory[Number(e.target.value)];
                    if (set) setValues(fitArgSet(set, signature.parameters.length));
                  }}
                >
                  <option value="">{t("runRoutineHistoryPlaceholder")}</option>
                  {argHistory.map((set, i) => (
                    // 履歴は並びが順序のみで一意な ID を持たないため、内容と位置をキーにする。
                    <option key={`${i}:${set.join("\u0001")}`} value={i}>
                      {describeArgSet(set)}
                    </option>
                  ))}
                </Select>
                <chakra.span textStyle="caption">{t("runRoutineHistoryNote")}</chakra.span>
              </FormSection>
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
                      if (isPlainEnterKey(e)) {
                        e.preventDefault();
                        // 後ろに入力できる引数が残っていれば次の欄へ移る。最後の欄でだけ実行する。
                        const next = args.slice(argIdx + 1).find((q) => routineParamTakesInput(q));
                        if (next) {
                          document
                            .getElementById(`run-routine-param-${signature.parameters.indexOf(next)}`)
                            ?.focus();
                        } else {
                          run();
                        }
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
          onClick={() => {
            if (!call) return;
            rememberArgs();
            onSendToEditor(call.sql);
          }}
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
