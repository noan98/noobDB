import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api } from "../api/tauri";
import type { AuditDdl, AuditOptions, AuditStatus } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { matchesMaskPattern } from "./columnMask";
import { ListboxSelect } from "./ListboxSelect";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Skeleton } from "./Skeleton";
import { SqlPreview } from "./SqlPreview";
import { Button, Checkbox, Input, PressableButton } from "./ui";

/**
 * 変更履歴 (監査) テーブルと INSERT / UPDATE / DELETE トリガーを生成するウィザード (#2305)。
 * 表の列と既存の監査トリガーを読み、オプションに応じた DDL (Rust の純関数が生成) をプレビューする。
 * 確定すると呼び出し側 (App) が DDL ゲート (本番確認) を通して 1 つのトランザクションで実行する
 * (read_only の拒否はバックエンドが行う。ここでは先回りして押せないようにする)。
 * 履歴は監査表をそのままグリッドで開いて見る (新しい常駐画面は作らない)。
 */
interface Props {
  sessionId: string;
  database: string;
  table: string;
  driver: string | undefined;
  readOnly: boolean;
  /** 機微カラムのマスク設定 (#1069) のパターン。一致する列は既定で記録しない。null はマスク無効。 */
  maskPatterns: readonly string[] | null;
  /** 構造パネルの「再生成」から開くときは `regenerate`。 */
  initialMode: "create" | "regenerate";
  onConfirm: (
    statements: string[],
    info: { mode: Mode; auditTable: string; dropsTable: boolean },
  ) => void | Promise<void>;
  onClose: () => void;
}

type Mode = "create" | "regenerate" | "remove";

const WARNING_KEYS: Record<string, string> = {
  no_primary_key: "auditWarnNoPk",
  mysql_trigger_privilege: "auditWarnMysqlPrivilege",
  mysql_binlog_trust: "auditWarnMysqlBinlog",
};

const EMPTY_OPTIONS: AuditOptions = {
  insert: true,
  update: true,
  delete: true,
  exclude_columns: [],
  skip_unchanged_update: true,
  audit_table: "",
  audit_schema: null,
};

export function AuditTriggerModal({
  sessionId,
  database,
  table,
  driver,
  readOnly,
  maskPatterns,
  initialMode,
  onConfirm,
  onClose,
}: Props) {
  const t = useT();
  const [columns, setColumns] = useState<string[] | null>(null);
  const [status, setStatus] = useState<AuditStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [options, setOptions] = useState<AuditOptions>(EMPTY_OPTIONS);
  const [dropTable, setDropTable] = useState(false);
  // 生成結果。どのオプションに対する結果かを `key` で持ち、現在の入力と一致するものだけを使う。
  const [ddlState, setDdlState] = useState<{ key: string; ddl: AuditDdl } | null>(null);
  const [ddlError, setDdlError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const nameRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 列と既存の監査状態を読み、既定のオプション (マスク対象の列は除外) を決める。
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.describeTable(sessionId, database, table),
      api.getAuditStatus(sessionId, database, table),
    ])
      .then(([cols, st]) => {
        if (cancelled) return;
        const names = cols.map((c) => c.name);
        setColumns(names);
        setStatus(st);
        const masked = (list: readonly string[]) =>
          maskPatterns ? list.filter((n) => matchesMaskPattern(n, maskPatterns)) : [];
        if (st.options) {
          // 再生成では、新しく増えたマスク対象の列も既定で除外する (機微な値を黙って記録しない)。
          const extra = masked(st.added_columns).filter((c) => !st.options?.exclude_columns.includes(c));
          setOptions({ ...st.options, exclude_columns: [...st.options.exclude_columns, ...extra] });
        } else {
          setOptions({ ...EMPTY_OPTIONS, exclude_columns: masked(names) });
        }
        // 既に監査がある表を「新規作成」では開けない。オプションを読み戻せたときだけ再生成にする
        // (読み戻せない既存の監査は、監査表名を指定して自分で操作を選ぶ)。
        setMode((m) => (!st.present ? "create" : st.options && m === "create" ? "regenerate" : m));
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(t("auditLoadError", { error: String(e) }));
        setColumns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table, maskPatterns, t]);

  const loading = columns === null;
  const isSqlite = driver === "sqlite";
  // 既存の監査があるのに作成時のオプションを読み戻せない (印の無い古い監査など)。
  const legacy = !!status?.present && !status.options;
  const noOps = !options.insert && !options.update && !options.delete;
  const allExcluded =
    columns !== null && columns.length > 0 && columns.every((c) => options.exclude_columns.includes(c));
  const sameTable = options.audit_table.trim() === table;
  const optionError: string | null = noOps
    ? t("auditErrNoOps")
    : allExcluded
      ? t("auditErrAllExcluded")
      : sameTable
        ? t("auditErrSameTable")
        : null;

  // 削除は読み戻したオプション (無ければ入力中の値) で DDL を作る。
  const effective = mode === "remove" ? (status?.options ?? options) : options;
  const effectiveKey = JSON.stringify(effective);
  const requestKey = `${mode}|${effectiveKey}`;
  // オプションを変えた直後は、前のオプションの結果を使わない (古い SQL を確定させない)。
  const ddl = ddlState?.key === requestKey ? ddlState.ddl : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: effective は effectiveKey で値比較する (毎回新しいオブジェクトになるため)
  useEffect(() => {
    if (loading || loadError || (mode !== "remove" && optionError)) {
      setDdlState(null);
      setDdlError(null);
      return;
    }
    let cancelled = false;
    api
      .generateAuditDdl(sessionId, database, table, effective, mode === "regenerate")
      .then((d) => {
        if (cancelled) return;
        setDdlState({ key: requestKey, ddl: d });
        setDdlError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setDdlState(null);
        setDdlError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table, mode, effectiveKey, requestKey, loading, loadError, optionError]);

  const statements = useMemo(() => {
    if (!ddl) return [];
    if (mode === "remove") return dropTable ? [...ddl.drop_triggers, ddl.drop_table] : ddl.drop_triggers;
    return ddl.create;
  }, [ddl, mode, dropTable]);
  const ready = !loading && !readOnly && statements.length > 0;

  const submit = () => {
    if (!ready || busy || !ddl) return;
    // 実行中は確定できない (二重送信で同じ DDL が 2 回走るのを防ぐ)。
    setBusy(true);
    void Promise.resolve()
      .then(() =>
        onConfirm(statements, {
          mode,
          auditTable: ddl.audit_table,
          dropsTable: mode === "remove" && dropTable,
        }),
      )
      .catch(() => {})
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  };

  const set = (patch: Partial<AuditOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const toggleExclude = (name: string, on: boolean) =>
    set({
      exclude_columns: on
        ? [...options.exclude_columns, name]
        : options.exclude_columns.filter((c) => c !== name),
    });

  const modeOptions: { value: Mode; label: string }[] = status?.present
    ? [
        { value: "regenerate", label: t("auditModeRegenerate") },
        { value: "remove", label: t("auditModeRemove") },
        ...(legacy ? [{ value: "create" as Mode, label: t("auditModeCreate") }] : []),
      ]
    : [{ value: "create", label: t("auditModeCreate") }];
  const removing = mode === "remove";
  const confirmLabel = removing
    ? t("auditConfirmRemove")
    : mode === "regenerate"
      ? t("auditConfirmRegenerate")
      : t("auditConfirmCreate");

  return (
    <Modal
      onSubmit={removing ? undefined : submit}
      submitDisabled={!ready || busy}
      width="680px"
      onClose={onClose}
      initialFocusEl={() => (removing ? cancelRef.current : nameRef.current)}
    >
      <ModalHeader onClose={onClose} closeLabel={t("auditCancel")}>
        {t("auditTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {readOnly && <Callout tone="warning">{t("auditReadOnly")}</Callout>}
        {loadError && <ErrorNote>{loadError}</ErrorNote>}
        {status?.needs_regeneration && mode === "regenerate" && (
          <Callout tone="warning">
            {status.pk_changed
              ? t("structureAuditPkChanged")
              : t("auditNeedsRegeneration", {
                  added: status.added_columns.join(", ") || "-",
                  removed: status.removed_columns.join(", ") || "-",
                })}
          </Callout>
        )}
        {status?.present && driver === "postgres" && <Callout tone="info">{t("auditPgGeneric")}</Callout>}
        {legacy && <Callout tone="warning">{t("auditLegacy")}</Callout>}
        {ddl?.warnings.map((w) =>
          WARNING_KEYS[w] ? (
            <Callout key={w} tone="warning">
              {t(WARNING_KEYS[w] as "auditWarnNoPk")}
            </Callout>
          ) : null,
        )}

        {status?.present && (
          <FormSection>
            <FieldLabel as="div">{t("auditMode")}</FieldLabel>
            <ListboxSelect
              ariaLabel={t("auditMode")}
              value={mode}
              options={modeOptions}
              disabled={readOnly}
              onChange={(v) => setMode(v as Mode)}
              css={{ width: "100%" }}
            />
          </FormSection>
        )}

        {loading ? (
          <Skeleton
            role="status"
            aria-label={t("spinnerLoadingAria")}
            style={{ height: "var(--space-8)", borderRadius: "var(--radius-md)" }}
          />
        ) : (
          <>
            {!removing && (
              <FormSection>
                <FieldLabel as="div">{t("auditOps")}</FieldLabel>
                <chakra.div display="flex" gap="4" flexWrap="wrap">
                  {(["insert", "update", "delete"] as const).map((op) => (
                    <chakra.label key={op} display="flex" alignItems="center" gap="2" textStyle="body">
                      <Checkbox
                        checked={options[op]}
                        disabled={readOnly}
                        onChange={(e) => set({ [op]: e.target.checked })}
                      />
                      {op.toUpperCase()}
                    </chakra.label>
                  ))}
                </chakra.div>
                {noOps && <FieldError>{t("auditErrNoOps")}</FieldError>}
                <chakra.label display="flex" alignItems="center" gap="2" textStyle="body">
                  <Checkbox
                    checked={options.skip_unchanged_update}
                    disabled={readOnly || !options.update}
                    onChange={(e) => set({ skip_unchanged_update: e.target.checked })}
                  />
                  {t("auditSkipUnchanged")}
                </chakra.label>
              </FormSection>
            )}

            {(!removing || legacy) && (
              <chakra.div display="grid" gridTemplateColumns={isSqlite ? "1fr" : "1fr 1fr"} gap="3">
                <FormSection>
                  <FieldLabel htmlFor="audit-table">{t("auditTableName")}</FieldLabel>
                  <Input
                    id="audit-table"
                    ref={nameRef}
                    fontFamily="mono"
                    value={options.audit_table}
                    placeholder={`${table}_audit`}
                    onChange={(e) => set({ audit_table: e.target.value })}
                    aria-invalid={sameTable ? true : undefined}
                    disabled={readOnly || (mode === "regenerate" && !legacy)}
                  />
                  {sameTable && <FieldError>{t("auditErrSameTable")}</FieldError>}
                </FormSection>
                {!isSqlite && (
                  <FormSection>
                    <FieldLabel htmlFor="audit-schema">{t("auditSchemaName")}</FieldLabel>
                    <Input
                      id="audit-schema"
                      fontFamily="mono"
                      value={options.audit_schema ?? ""}
                      placeholder={database}
                      onChange={(e) => set({ audit_schema: e.target.value === "" ? null : e.target.value })}
                      disabled={readOnly || (mode === "regenerate" && !legacy)}
                    />
                  </FormSection>
                )}
              </chakra.div>
            )}

            {!removing && (
              <FormSection>
                <FieldLabel as="div">{t("auditExcludeColumns")}</FieldLabel>
                <chakra.div display="flex" columnGap="4" rowGap="2" flexWrap="wrap">
                  {(columns ?? []).map((c) => (
                    <chakra.label key={c} display="flex" alignItems="center" gap="2" textStyle="body">
                      <Checkbox
                        checked={options.exclude_columns.includes(c)}
                        disabled={readOnly}
                        onChange={(e) => toggleExclude(c, e.target.checked)}
                      />
                      <chakra.span fontFamily="mono">{c}</chakra.span>
                    </chakra.label>
                  ))}
                </chakra.div>
                <chakra.span textStyle="caption" color="app.textMuted">
                  {t("auditExcludeHint")}
                </chakra.span>
                {allExcluded && <FieldError>{t("auditErrAllExcluded")}</FieldError>}
              </FormSection>
            )}
          </>
        )}

        {removing && (
          <chakra.label display="flex" alignItems="center" gap="2" textStyle="body">
            <Checkbox
              checked={dropTable}
              disabled={readOnly}
              onChange={(e) => setDropTable(e.target.checked)}
            />
            {t("auditDropTable", { name: ddl?.audit_table ?? "" })}
          </chakra.label>
        )}
        {ddlError && <ErrorNote>{ddlError}</ErrorNote>}

        <FormSection>
          <FieldLabel as="div">{t("auditPreview")}</FieldLabel>
          <SqlPreview
            sql={statements.length > 0 ? `${statements.join(";\n\n")};` : ""}
            driver={driver}
            empty={t("auditPreviewEmpty")}
            minH="48px"
            wrap
          />
        </FormSection>
      </ModalBody>
      <ModalFooter>
        {removing ? (
          <>
            <Button type="button" variant="dangerOutline" disabled={!ready || busy} onClick={submit}>
              {confirmLabel}
            </Button>
            <div style={{ flex: 1 }} />
            <Button ref={cancelRef} type="button" variant="primary" onClick={onClose}>
              {t("auditCancel")}
            </Button>
          </>
        ) : (
          <>
            <div style={{ flex: 1 }} />
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("auditCancel")}
            </Button>
            <PressableButton type="button" variant="primary" disabled={!ready || busy} onClick={submit}>
              {confirmLabel}
            </PressableButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
