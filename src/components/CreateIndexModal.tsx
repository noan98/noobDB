import { useCallback, useEffect, useMemo, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { useT } from "../i18n";
import { api, type DriverKind, type IndexOverlap, type TableColumnInfo } from "../api/tauri";
import {
  buildCreateIndexSql,
  indexOptionSupport,
  normalizeIndexFragment,
  type IndexMethod,
  type IndexOptionReason,
} from "./tableMaintenance";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldError, FieldLabel, FormSection } from "./modalForm";
import { Callout } from "./Callout";
import { AlterPrecheckNotice } from "./AlterPrecheckNotice";
import { buildConstraintPrechecks } from "./alterPrecheck";
import { COUNT_PREVIEW_TIMEOUT_SECS, useCountPreviews } from "../useCountPreviews";
import { Icon } from "./Icon";
import { Button, Checkbox, Input, PressableButton, Select, Switch } from "./ui";

/**
 * インデックス作成の軽量モーダル (#850)。`describeTable` で列一覧を取得し、選択した
 * 列 + UNIQUE + 任意のインデックス名から `CREATE INDEX` 文を生成・プレビューして
 * 実行する。SQL 生成の純ロジックは `tableMaintenance.ts` の `buildCreateIndexSql`
 * (方言分岐はバックエンドの `db/advisor.rs::create_index_ddl` の移植で、アドバイザの
 * 自動修正 DDL と同じ命名規則を使う)。
 *
 * 列編集ダイアログ (`AlterTableModal`、#794) にもインデックス追加のフォームが
 * 含まれるが、あちらは既存列の一覧・追加・削除まで一式を読み込む重量な画面。
 * こちらはテーブル右クリックから直接開ける単一目的の近道で、`CreateTableModal` と
 * 同じ「軽量モーダル + プレビュー」の流儀を踏襲する (二重実装ではなく、
 * `SaveAsTableModal` のように既存の重量フォームと共存する専用の近道)。
 *
 * read_only セッションでは実行ボタンを無効化する (バックエンドも write を拒否する)。
 */
interface Props {
  sessionId: string;
  driver: DriverKind;
  database: string | null;
  table: string;
  readOnly: boolean;
  onRun: (sql: string) => void;
  onSendToEditor: (sql: string) => void;
  onClose: () => void;
}

export function CreateIndexModal({
  sessionId,
  driver,
  database,
  table,
  readOnly,
  onRun,
  onSendToEditor,
  onClose,
}: Props) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [unique, setUnique] = useState(false);
  // 詳細オプション (#1892): 式キー / メソッド / 部分インデックス条件 / INCLUDE 列。
  const [expressions, setExpressions] = useState<string[]>([]);
  const [method, setMethod] = useState<IndexMethod | "">("");
  const [where, setWhere] = useState("");
  const [include, setInclude] = useState<string[]>([]);
  // 同じ列構成の既存インデックス (#1625)。判定はバックエンド (アドバイザの重複検出と同じ)。
  const [overlaps, setOverlaps] = useState<IndexOverlap[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .describeTable(sessionId, database ?? "", table)
      .then((cols: TableColumnInfo[]) => {
        if (cancelled) return;
        setColumns(cols.map((c) => c.name));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table]);

  const toggleColumn = (col: string) =>
    setSelected((cols) => (cols.includes(col) ? cols.filter((c) => c !== col) : [...cols, col]));

  // 複合インデックスの列順 (先頭列が最左一致の基準) を入れ替える。
  const moveSelected = (col: string, dir: -1 | 1) =>
    setSelected((cols) => {
      const i = cols.indexOf(col);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cols.length) return cols;
      const next = [...cols];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const support = indexOptionSupport(driver, method || undefined);
  const effUnique = unique && support.unique;
  const hasExpr = support.expression && expressions.some((e) => e.trim() !== "");
  const hasWhere = support.where && where.trim() !== "";
  // 重複チェックは列構成だけで判定するので、メソッド・式・WHERE があると誤警告になる。
  // UNIQUE の事前 COUNT は式・WHERE のときだけ外す (メソッドは重複キーの有無に影響しない)。
  const plainIndex = !hasExpr && !hasWhere && method === "";
  const uniqueCheckable = !hasExpr && !hasWhere;

  useEffect(() => {
    // 式キー / 部分インデックス / メソッド指定があると列構成だけでは重複判定できないため確認しない。
    if (selected.length === 0 || !plainIndex) {
      setOverlaps([]);
      return;
    }
    let cancelled = false;
    api
      .checkDuplicateIndex(sessionId, database ?? "", table, selected, effUnique)
      .then((r) => {
        if (!cancelled) setOverlaps(r);
      })
      .catch(() => {
        // 警告は補助情報。取れなくても作成自体は妨げない。
        if (!cancelled) setOverlaps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table, selected, effUnique, plainIndex]);

  const exprCount = support.expression ? expressions.filter((e) => e.trim() !== "").length : 0;
  const whereBad = support.where && normalizeIndexFragment(where).error;
  const exprBad = support.expression && expressions.some((e) => normalizeIndexFragment(e).error);
  const keyCount = selected.length + exprCount;
  const tooManyKeys = support.singleColumn && keyCount > 1;
  const valid = keyCount > 0 && !whereBad && !exprBad && !tooManyKeys;
  const sql = useMemo(
    () =>
      valid
        ? buildCreateIndexSql(driver, database, table, selected, {
            name,
            unique,
            expressions,
            method: method || undefined,
            where,
            include,
          })
        : "",
    [valid, driver, database, table, selected, name, unique, expressions, method, where, include],
  );
  const reasonText = (r: IndexOptionReason | undefined) => (r ? t(`createIndexReason_${r}`) : null);

  // UNIQUE のときだけ、既存データに重複キーが無いかを読み取り専用 COUNT で事前検査する (#1757)。
  const prechecks = useMemo(
    () =>
      valid && effUnique && uniqueCheckable
        ? buildConstraintPrechecks(driver, database, table, {
            indexes: [{ name, columns: selected, unique: effUnique }],
          })
        : [],
    [valid, effUnique, uniqueCheckable, driver, database, table, name, selected],
  );
  const runCount = useCallback(
    (countSql: string) =>
      api.runLookupQuery({
        sessionId,
        sql: countSql,
        database,
        queryTimeoutSecs: COUNT_PREVIEW_TIMEOUT_SECS,
        rowCap: 1,
      }),
    [sessionId, database],
  );
  const precheckCounts = useCountPreviews(runCount, prechecks, !loading && !loadError);

  return (
    <Modal onSubmit={() => onRun(sql)} submitDisabled={!valid || readOnly} width="600px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("createTableClose")}>
        {t("createIndexTitle", { table })}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {loading && (
          <chakra.span fontSize="sm" color="app.textMuted">
            {t("alterTableLoading")}
          </chakra.span>
        )}
        {loadError && <ErrorNote>{t("alterTableLoadError", { error: loadError })}</ErrorNote>}
        {!loading && !loadError && (
          <>
            <Flex align="center" gap="2">
              <FieldLabel htmlFor="create-index-name" minW="90px">
                {t("createIndexName")}
              </FieldLabel>
              <Input
                id="create-index-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("createIndexNamePlaceholder")}
                flex="1"
              />
            </Flex>
            <Switch
              checked={effUnique}
              disabled={!support.unique}
              onChange={() => setUnique(!unique)}
              label={t("createTableColUnique")}
            />
            {reasonText(support.reasons.unique) && (
              <chakra.span textStyle="caption" data-testid="create-index-reason-unique">
                {reasonText(support.reasons.unique)}
              </chakra.span>
            )}
            <FormSection>
              <FieldLabel as="div">{t("createIndexColumns")}</FieldLabel>
              <Flex gap="3" wrap="wrap">
                {columns.length === 0 && (
                  <chakra.span fontSize="xs" color="app.textMuted">
                    {t("treeNoColumns")}
                  </chakra.span>
                )}
                {columns.map((col) => (
                  <chakra.label key={col} display="flex" alignItems="center" gap="1" fontSize="sm">
                    <Checkbox
                      checked={selected.includes(col)}
                      disabled={support.singleColumn && !selected.includes(col) && keyCount >= 1}
                      onChange={() => toggleColumn(col)}
                    />
                    {col}
                    {selected.includes(col) && (
                      <chakra.span
                        data-testid={`create-index-order-${col}`}
                        textStyle="caption"
                        aria-label={t("createIndexOrderAria", { n: selected.indexOf(col) + 1 })}
                      >
                        {selected.indexOf(col) + 1}
                      </chakra.span>
                    )}
                  </chakra.label>
                ))}
              </Flex>
              {reasonText(support.reasons.columns) && (
                <chakra.span textStyle="caption" data-testid="create-index-reason-columns">
                  {reasonText(support.reasons.columns)}
                </chakra.span>
              )}
              {selected.length > 1 && (
                <Flex gap="2" wrap="wrap" align="center" data-testid="create-index-order">
                  {selected.map((col, i) => (
                    <Flex key={col} align="center" gap="1" fontSize="sm">
                      <chakra.span color="app.textMuted">{i + 1}.</chakra.span>
                      {col}
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={i === 0}
                        aria-label={t("createIndexMoveEarlier", { column: col })}
                        onClick={() => moveSelected(col, -1)}
                      >
                        <Icon name="chevron-left" />
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={i === selected.length - 1}
                        aria-label={t("createIndexMoveLater", { column: col })}
                        onClick={() => moveSelected(col, 1)}
                      >
                        <Icon name="chevron-right" />
                      </Button>
                    </Flex>
                  ))}
                </Flex>
              )}
            </FormSection>
            <FormSection>
              <FieldLabel as="div">{t("createIndexExpressions")}</FieldLabel>
              {support.expression ? (
                <>
                  {expressions.map((e, i) => (
                    <Flex key={i} align="center" gap="2">
                      <Input
                        aria-label={t("createIndexExpressionAria", { n: i + 1 })}
                        value={e}
                        onChange={(ev) =>
                          setExpressions((xs) => xs.map((x, j) => (j === i ? ev.target.value : x)))
                        }
                        placeholder={t(
                          driver === "mysql"
                            ? "createIndexExpressionPlaceholderMysql"
                            : "createIndexExpressionPlaceholder",
                        )}
                        flex="1"
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        aria-label={t("createIndexExpressionRemove", { n: i + 1 })}
                        onClick={() => setExpressions((xs) => xs.filter((_, j) => j !== i))}
                      >
                        <Icon name="close" />
                      </Button>
                    </Flex>
                  ))}
                  <Flex>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setExpressions((xs) => [...xs, ""])}
                    >
                      {t("createIndexExpressionAdd")}
                    </Button>
                  </Flex>
                  {exprBad && <FieldError>{t("createIndexFragmentSemicolon")}</FieldError>}
                </>
              ) : (
                <chakra.span textStyle="caption">{reasonText(support.reasons.expression)}</chakra.span>
              )}
            </FormSection>
            <FormSection>
              <Flex align="center" gap="2">
                <FieldLabel htmlFor="create-index-method" minW="90px">
                  {t("createIndexMethod")}
                </FieldLabel>
                <Select
                  id="create-index-method"
                  value={method}
                  disabled={support.methods.length === 0}
                  onChange={(e) => setMethod(e.target.value as IndexMethod | "")}
                  flex="1"
                >
                  <option value="">{t("createIndexMethodDefault")}</option>
                  {support.methods.map((m) => (
                    <option key={m} value={m}>
                      {m.toUpperCase()}
                    </option>
                  ))}
                </Select>
              </Flex>
              {driver === "mysql" && method === "hash" && (
                <chakra.span textStyle="caption" data-testid="create-index-note-hash">
                  {t("createIndexMysqlHashNote")}
                </chakra.span>
              )}
              {reasonText(support.reasons.method) && (
                <chakra.span textStyle="caption" data-testid="create-index-reason-method">
                  {reasonText(support.reasons.method)}
                </chakra.span>
              )}
            </FormSection>
            <FormSection>
              <Flex align="center" gap="2">
                <FieldLabel htmlFor="create-index-where" minW="90px">
                  {t("createIndexWhere")}
                </FieldLabel>
                <Input
                  id="create-index-where"
                  value={where}
                  disabled={!support.where}
                  onChange={(e) => setWhere(e.target.value)}
                  placeholder={t("createIndexWherePlaceholder")}
                  flex="1"
                />
              </Flex>
              {reasonText(support.reasons.where) && (
                <chakra.span textStyle="caption" data-testid="create-index-reason-where">
                  {reasonText(support.reasons.where)}
                </chakra.span>
              )}
              {whereBad && <FieldError>{t("createIndexFragmentSemicolon")}</FieldError>}
            </FormSection>
            <FormSection>
              <FieldLabel as="div">{t("createIndexInclude")}</FieldLabel>
              {support.include ? (
                <Flex gap="3" wrap="wrap">
                  {columns
                    .filter((c) => !selected.includes(c))
                    .map((col) => (
                      <chakra.div key={col} display="flex" alignItems="center" gap="1" fontSize="sm">
                        <Checkbox
                          aria-label={t("createIndexIncludeAria", { column: col })}
                          checked={include.includes(col)}
                          onChange={() =>
                            setInclude((cs) =>
                              cs.includes(col) ? cs.filter((c) => c !== col) : [...cs, col],
                            )
                          }
                        />
                        {col}
                      </chakra.div>
                    ))}
                </Flex>
              ) : (
                <chakra.span textStyle="caption" data-testid="create-index-reason-include">
                  {reasonText(support.reasons.include)}
                </chakra.span>
              )}
            </FormSection>
            <FormSection>
              <FieldLabel as="div">{t("createTablePreview")}</FieldLabel>
              <CodePreview minH="48px" wrap>
                {sql || t("createIndexPreviewEmpty")}
              </CodePreview>
              {overlaps.map((o) => (
                <Callout key={o.name} tone="warning" data-testid="create-index-overlap">
                  {o.kind === "duplicate"
                    ? t("createIndexOverlapDuplicate", { name: o.name })
                    : o.kind === "covered_by_existing"
                      ? t("createIndexOverlapCovered", { name: o.name })
                      : t("createIndexOverlapRedundant", { name: o.name })}
                </Callout>
              ))}
              <AlterPrecheckNotice
                prechecks={prechecks}
                counts={precheckCounts}
                onOpenRows={onSendToEditor}
              />
              {valid && selected.length > 0 && (method === "" || method === "btree") && (
                <chakra.span textStyle="caption" data-testid="create-index-leading">
                  {t("createIndexLeadingColumn", { column: selected[0] })}
                </chakra.span>
              )}
            </FormSection>
            {readOnly && <FieldError>{t("createTableReadOnly")}</FieldError>}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" disabled={!valid} onClick={() => onSendToEditor(sql)}>
          {t("createTableToEditor")}
        </Button>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("createTableClose")}
        </Button>
        <PressableButton
          type="button"
          variant="primary"
          disabled={!valid || readOnly}
          onClick={() => onRun(sql)}
        >
          {t("createIndexRun")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
