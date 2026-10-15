import { useEffect, useMemo, useState } from "react";
import { chakra } from "@chakra-ui/react";

import { api, type ForeignKey, type SandboxCreateResponse } from "../api/tauri";
import { useT } from "../i18n";
import {
  SANDBOX_DEFAULT_ROW_LIMIT,
  SANDBOX_MAX_ROW_LIMIT,
  clampSandboxRowLimit,
  isSandboxShadowTableName,
  sandboxFkClosure,
} from "../sandbox";
import { Callout } from "./Callout";
import { LoadingButton } from "./LoadingButton";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Button, Checkbox, Input } from "./ui";
import { DraftNumberInput } from "./DraftNumberInput";

interface Props {
  sessionId: string;
  database: string;
  defaultName: string;
  onClose: () => void;
  onCreated: (res: SandboxCreateResponse) => void;
}

/**
 * サンドボックス (壊せる砂場) の作成モーダル (#747)。対象データベースのテーブル
 * 一覧 + FK を読み込み、テーブル選択・関連テーブル自動追加 (`sandboxFkClosure`)・
 * 行数上限・名前を入力させて `create_sandbox` を呼ぶ。テーブル選択・FK 閉包の
 * プレビュー UX は `SchemaExportModal` (#744) と同じ発想を踏襲する。
 */
export function SandboxCreateModal({ sessionId, database, defaultName, onClose, onCreated }: Props) {
  const t = useT();

  const [tables, setTables] = useState<string[] | null>(null);
  const [fks, setFks] = useState<ForeignKey[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fkError, setFkError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeRelated, setIncludeRelated] = useState(true);
  const [filter, setFilter] = useState("");
  // 表ごとの抽出条件 (WHERE の中身, #1625)。直接選んだ表だけに掛かる。
  const [rowFilters, setRowFilters] = useState<Record<string, string>>({});
  const [rowLimit, setRowLimit] = useState(SANDBOX_DEFAULT_ROW_LIMIT);
  const [name, setName] = useState(defaultName);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // 外部キーは任意機能 (関連テーブルの自動追加) にしか使わないので、取得に失敗しても
        // テーブル一覧は出して作成を続けられるようにする。
        const [tbls, foreignKeys] = await Promise.all([
          api.listTables(sessionId, database),
          api.foreignKeys(sessionId, database).catch((e: unknown) => {
            if (!cancelled) {
              setFkError(String(e));
              setIncludeRelated(false);
            }
            return [] as ForeignKey[];
          }),
        ]);
        if (cancelled) return;
        setTables(tbls.filter((tbl) => !isSandboxShadowTableName(tbl)));
        setFks(foreignKeys);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, database]);

  const effective = useMemo(() => {
    const base = [...selected];
    return includeRelated ? sandboxFkClosure(base, fks) : [...base].sort();
  }, [selected, includeRelated, fks]);

  const filteredTables = useMemo(() => {
    if (!tables) return [];
    const q = filter.trim().toLowerCase();
    return q ? tables.filter((tbl) => tbl.toLowerCase().includes(q)) : tables;
  }, [tables, filter]);

  const toggle = (tbl: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tbl)) next.delete(tbl);
      else next.add(tbl);
      return next;
    });
  };

  const submit = async () => {
    if (selected.size === 0 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api.createSandbox({
        sourceSessionId: sessionId,
        sourceDatabase: database,
        name: name.trim() || defaultName,
        tables: [...selected].map((name) => ({ name, filter: rowFilters[name] ?? null })),
        includeRelated,
        rowLimit,
      });
      onCreated(res);
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  };

  return (
    <Modal
      onSubmit={submit}
      submitDisabled={creating || selected.size === 0}
      width="560px"
      onClose={onClose}
      closeOnInteractOutside={!creating}
      closeOnEscape={!creating}
    >
      <ModalHeader onClose={onClose} closeLabel={t("sandboxCreateClose")} closeDisabled={creating}>
        {t("sandboxCreateTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight={1.5}>
          {t("sandboxCreateNote")}
        </chakra.div>
        <Callout tone="info" role="note" fontSize="xs">
          {t("sandboxCreateLimitationNote")}
        </Callout>

        <FormSection>
          <FieldLabel as="label" htmlFor="sandbox-create-name">
            {t("sandboxCreateName")}
          </FieldLabel>
          <Input
            id="sandbox-create-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
          />
        </FormSection>

        {loadError && <ErrorNote>{loadError}</ErrorNote>}
        {fkError && (
          <Callout tone="warning" role="status">
            {t("sandboxCreateFkLoadFailed", { error: fkError })}
          </Callout>
        )}
        {tables === null && !loadError && (
          <chakra.div fontSize="sm" color="app.textSecondary">
            {t("sandboxCreateLoadingTables")}
          </chakra.div>
        )}
        {tables !== null && tables.length === 0 && (
          <chakra.div fontSize="sm" color="app.textMuted">
            {t("sandboxCreateNoTables")}
          </chakra.div>
        )}
        {tables !== null && tables.length > 0 && (
          <>
            <FormSection>
              <FieldLabel as="div">{t("sandboxCreateTables", { count: selected.size })}</FieldLabel>
              <Input
                type="search"
                placeholder={t("listSearchPlaceholder")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                mb="2"
                disabled={creating}
              />
              <chakra.div
                maxH="220px"
                overflowY="auto"
                border="1px solid"
                borderColor="app.border"
                borderRadius="md"
                p="1.5"
                display="flex"
                flexDirection="column"
                gap="0.5"
              >
                {filteredTables.map((tbl) => (
                  <chakra.label
                    key={tbl}
                    display="flex"
                    alignItems="center"
                    gap="1.5"
                    fontSize="sm"
                    fontFamily="mono"
                    px="1"
                    py="0.5"
                    cursor="pointer"
                  >
                    <Checkbox checked={selected.has(tbl)} onChange={() => toggle(tbl)} disabled={creating} />
                    {tbl}
                  </chakra.label>
                ))}
              </chakra.div>
            </FormSection>

            <chakra.label display="inline-flex" alignItems="center" gap="1.5" fontSize="sm" cursor="pointer">
              <Checkbox
                checked={includeRelated}
                onChange={(e) => setIncludeRelated(e.target.checked)}
                disabled={creating}
              />
              {t("sandboxCreateIncludeRelated")}
            </chakra.label>
            {includeRelated && effective.length > selected.size && (
              <chakra.div fontSize="xs" color="app.textMuted">
                {t("sandboxCreateRelatedPreview", { count: effective.length })}
              </chakra.div>
            )}

            {selected.size > 0 && (
              <FormSection>
                <FieldLabel as="div">{t("sandboxCreateFilters")}</FieldLabel>
                <chakra.div textStyle="caption" color="app.textMuted" mb="1.5">
                  {t("sandboxCreateFiltersHint")}
                </chakra.div>
                <chakra.div display="flex" flexDirection="column" gap="1.5">
                  {[...selected].sort().map((tbl) => (
                    <chakra.div key={tbl} display="flex" alignItems="center" gap="2">
                      <chakra.span fontSize="sm" fontFamily="mono" minWidth="30%" truncate>
                        {tbl}
                      </chakra.span>
                      <Input
                        aria-label={t("sandboxCreateFilterLabel", { table: tbl })}
                        placeholder={t("sandboxCreateFilterPlaceholder")}
                        value={rowFilters[tbl] ?? ""}
                        onChange={(e) => setRowFilters((prev) => ({ ...prev, [tbl]: e.target.value }))}
                        disabled={creating}
                        fontFamily="mono"
                      />
                    </chakra.div>
                  ))}
                </chakra.div>
                {includeRelated && effective.length > selected.size && (
                  <chakra.div textStyle="caption" color="app.textMuted" mt="1.5">
                    {t("sandboxCreateFiltersRelatedNote")}
                  </chakra.div>
                )}
              </FormSection>
            )}

            <FormSection>
              <FieldLabel as="label" htmlFor="sandbox-create-row-limit">
                {t("sandboxCreateRowLimit")}
              </FieldLabel>
              <DraftNumberInput
                id="sandbox-create-row-limit"
                min={1}
                max={SANDBOX_MAX_ROW_LIMIT}
                value={rowLimit}
                onCommit={(n) => setRowLimit(clampSandboxRowLimit(n))}
                disabled={creating}
              />
            </FormSection>
          </>
        )}

        {error && <ErrorNote>{error}</ErrorNote>}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose} disabled={creating}>
          {t("sandboxCreateCancel")}
        </Button>
        <LoadingButton
          pressable
          variant="primary"
          loading={creating}
          onClick={submit}
          disabled={selected.size === 0}
        >
          {t("sandboxCreateSubmit")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}
