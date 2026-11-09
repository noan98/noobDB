import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { ListboxSelect } from "./ListboxSelect";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { SqlPreview } from "./SqlPreview";
import { Spinner } from "./Spinner";
import { Button, Checkbox, Input, PressableButton, Textarea } from "./ui";
import {
  buildPolicyStatements,
  formatPolicyPreview,
  POLICY_COMMANDS,
  POLICY_KINDS,
  usingAllowed,
  validatePolicyName,
  withCheckAllowed,
  type PolicyCommand,
  type PolicyKind,
  type PolicyNameError,
} from "./policySql";

/**
 * PostgreSQL の行レベルセキュリティ (RLS) ポリシーを作るダイアログ (#2159)。
 * 表・名前・コマンド・ロール・`USING` / `WITH CHECK` を入力すると `CREATE POLICY` (必要なら
 * `ALTER TABLE ... ENABLE / FORCE ROW LEVEL SECURITY` も) をその場でプレビューする。確定すると呼び出し側 (App) が
 * 1 つのトランザクションで実行する (read_only の拒否はバックエンドが行う。ここでは先回りして押せないようにする)。
 */
interface Props {
  sessionId: string;
  /** PostgreSQL のスキーマ (ツリーの「データベース」)。 */
  database: string;
  /** 右クリックした表。なければ先頭の表。 */
  initialTable: string | null;
  readOnly: boolean;
  onConfirm: (statements: string[], policyName: string) => void | Promise<void>;
  onClose: () => void;
}

const NAME_ERROR_KEYS = {
  empty: "policyErrEmpty",
  tooLong: "policyErrTooLong",
  duplicate: "policyErrDuplicate",
} as const satisfies Record<PolicyNameError, string>;

export function PolicyModal({ sessionId, database, initialTable, readOnly, onConfirm, onClose }: Props) {
  const t = useT();
  const [tables, setTables] = useState<string[] | null>(null);
  const [policiesByTable, setPoliciesByTable] = useState<Record<string, string[]>>({});
  const [rlsOn, setRlsOn] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [table, setTable] = useState(initialTable ?? "");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PolicyKind>("PERMISSIVE");
  const [command, setCommand] = useState<PolicyCommand>("ALL");
  const [roles, setRoles] = useState("");
  const [using, setUsing] = useState("");
  const [withCheck, setWithCheck] = useState("");
  const [enableRls, setEnableRls] = useState<boolean | null>(null);
  const [forceRls, setForceRls] = useState(false);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 表の一覧 (ビューは RLS を持てないので除く)・既存のポリシー名・RLS の有効状態を読む。
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listTables(sessionId, database),
      api.listSchemaObjects(sessionId, database),
      api.listRlsTables(sessionId, database).catch(() => []),
    ])
      .then(([allTables, objects, rls]) => {
        if (cancelled) return;
        const views = new Set(
          objects.filter((o) => o.kind === "view" || o.kind === "materialized_view").map((o) => o.name),
        );
        const byTable: Record<string, string[]> = {};
        for (const o of objects) {
          if (o.kind === "policy" && o.detail) (byTable[o.detail] ??= []).push(o.name);
        }
        setTables(allTables.filter((tbl) => !views.has(tbl)));
        setPoliciesByTable(byTable);
        setRlsOn(Object.fromEntries(rls.map((r) => [r.table, r.enabled])));
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(t("policyLoadError", { error: String(e) }));
        setTables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, t]);

  const loading = tables === null;
  const tableList = tables ?? [];
  const selectedTable = tableList.includes(table) ? table : (tableList[0] ?? "");
  const alreadyOn = rlsOn[selectedTable] === true;
  // 既定: RLS が無効な表なら有効にする。有効な表では何もしない (ユーザーが明示的に選べる)。
  const enable = enableRls ?? !alreadyOn;
  const nameError = name === "" ? null : validatePolicyName(name, policiesByTable[selectedTable] ?? []);
  const useUsing = usingAllowed(command);
  const useCheck = withCheckAllowed(command);

  const statements = useMemo(
    () =>
      name === "" || nameError !== null || selectedTable === ""
        ? []
        : buildPolicyStatements({
            schema: database,
            table: selectedTable,
            name,
            kind,
            command,
            roles,
            using: useUsing ? using : "",
            withCheck: useCheck ? withCheck : "",
            enableRls: enable,
            forceRls: (enable || alreadyOn) && forceRls,
          }),
    [
      database,
      selectedTable,
      name,
      nameError,
      kind,
      command,
      roles,
      using,
      withCheck,
      useUsing,
      useCheck,
      enable,
      alreadyOn,
      forceRls,
    ],
  );
  const ready = !loading && !readOnly && statements.length > 0;

  const submit = () => {
    if (!ready || busy) return;
    // 実行中は確定できない (二重送信で同じ CREATE POLICY が 2 回走るのを防ぐ)。
    setBusy(true);
    void Promise.resolve()
      .then(() => onConfirm(statements, name))
      .catch(() => {})
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  };

  const tableOptions = tableList.map((v) => ({ value: v }));
  const kindOptions = POLICY_KINDS.map((k) => ({
    value: k,
    label: k === "PERMISSIVE" ? t("policyKindPermissive") : t("policyKindRestrictive"),
  }));
  const commandOptions = POLICY_COMMANDS.map((c) => ({
    value: c,
    label: c === "ALL" ? t("policyCommandAll") : c,
  }));

  return (
    <Modal
      onSubmit={submit}
      submitDisabled={!ready || busy}
      width="640px"
      onClose={onClose}
      initialFocusEl={() => nameRef.current}
    >
      <ModalHeader onClose={onClose} closeLabel={t("policyCancel")}>
        {t("policyTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {readOnly && <Callout tone="warning">{t("policyReadOnly")}</Callout>}
        {loadError && <ErrorNote>{loadError}</ErrorNote>}
        {!loading && !loadError && tableList.length === 0 && (
          <Callout tone="info">{t("policyNoTables")}</Callout>
        )}

        <FormSection>
          <FieldLabel htmlFor="policy-table">{t("policyTable")}</FieldLabel>
          {loading ? (
            <Spinner size={14} />
          ) : (
            <ListboxSelect
              id="policy-table"
              value={selectedTable}
              disabled={tableList.length === 0 || readOnly}
              options={tableOptions}
              onChange={(v) => {
                setTable(v);
                setEnableRls(null);
              }}
              css={{ width: "100%" }}
            />
          )}
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="policy-name">{t("policyName")}</FieldLabel>
          <Input
            id="policy-name"
            ref={nameRef}
            fontFamily="mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={nameError ? true : undefined}
            disabled={readOnly}
          />
          {nameError && <FieldError>{t(NAME_ERROR_KEYS[nameError])}</FieldError>}
        </FormSection>

        <chakra.div display="grid" gridTemplateColumns="1fr 1fr" gap="3">
          <FormSection>
            <FieldLabel as="div">{t("policyKind")}</FieldLabel>
            <ListboxSelect
              ariaLabel={t("policyKind")}
              value={kind}
              options={kindOptions}
              disabled={readOnly}
              onChange={(v) => setKind(v as PolicyKind)}
              css={{ width: "100%" }}
            />
          </FormSection>
          <FormSection>
            <FieldLabel as="div">{t("policyCommand")}</FieldLabel>
            <ListboxSelect
              ariaLabel={t("policyCommand")}
              value={command}
              options={commandOptions}
              disabled={readOnly}
              onChange={(v) => setCommand(v as PolicyCommand)}
              css={{ width: "100%" }}
            />
          </FormSection>
        </chakra.div>

        <FormSection>
          <FieldLabel htmlFor="policy-roles">{t("policyRoles")}</FieldLabel>
          <Input
            id="policy-roles"
            fontFamily="mono"
            value={roles}
            placeholder={t("policyRolesPlaceholder")}
            onChange={(e) => setRoles(e.target.value)}
            disabled={readOnly}
          />
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="policy-using">{t("policyUsing")}</FieldLabel>
          <Textarea
            id="policy-using"
            fontFamily="mono"
            rows={2}
            value={useUsing ? using : ""}
            placeholder={useUsing ? t("policyExprPlaceholder") : t("policyExprNotUsed")}
            onChange={(e) => setUsing(e.target.value)}
            disabled={readOnly || !useUsing}
          />
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="policy-check">{t("policyWithCheck")}</FieldLabel>
          <Textarea
            id="policy-check"
            fontFamily="mono"
            rows={2}
            value={useCheck ? withCheck : ""}
            placeholder={useCheck ? t("policyExprPlaceholder") : t("policyExprNotUsed")}
            onChange={(e) => setWithCheck(e.target.value)}
            disabled={readOnly || !useCheck}
          />
        </FormSection>

        <FormSection>
          {alreadyOn ? (
            <chakra.span textStyle="caption" color="app.textMuted">
              {t("policyRlsAlreadyOn")}
            </chakra.span>
          ) : (
            <chakra.label display="flex" alignItems="center" gap="2" textStyle="body">
              <Checkbox
                checked={enable}
                disabled={readOnly}
                onChange={(e) => setEnableRls(e.target.checked)}
              />
              {t("policyEnableRls")}
            </chakra.label>
          )}
          <chakra.label display="flex" alignItems="center" gap="2" textStyle="body">
            <Checkbox
              checked={forceRls}
              disabled={readOnly || (!enable && !alreadyOn)}
              onChange={(e) => setForceRls(e.target.checked)}
            />
            {t("policyForceRls")}
          </chakra.label>
        </FormSection>

        {!enable && !alreadyOn && <Callout tone="info">{t("policyRlsOffNote")}</Callout>}

        <FormSection>
          <FieldLabel as="div">{t("policyPreview")}</FieldLabel>
          <SqlPreview
            sql={statements.length > 0 ? formatPolicyPreview(statements) : ""}
            driver="postgres"
            empty={t("policyPreviewEmpty")}
            minH="48px"
            wrap
          />
        </FormSection>
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("policyCancel")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!ready || busy} onClick={submit}>
          {t("policyConfirm")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
