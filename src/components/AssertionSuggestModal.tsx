import { useEffect, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { api, type Assertion, type ConnectionProfile } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { dialectLabel } from "../ai/errorExplain";
import {
  ASSERTION_SUGGEST_FORMAT,
  buildAssertionSuggestPrompt,
  buildAssertionSuggestSystemParts,
  isRegistrableSuggestionSql,
  parseAssertionSuggestResponse,
  selectTableForeignKeys,
  suggestionToDraft,
  type AssertionSuggestColumn,
  type AssertionSuggestForeignKey,
} from "../ai/assertionSuggest";
import { useAiStream } from "../ai/useAiStream";
import { useLocale, useT } from "../i18n";
import { useSettings } from "../settings";
import { AiStreamProgress } from "./AiStreamProgress";
import { AiUsageNote } from "./AiUsageNote";
import { draftToRequest } from "./assertions";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Button, Checkbox, Input, Textarea } from "./ui";
import { SqlCountCheck } from "./SqlCountCheck";

/** 一度に生成できるテーブル数の上限 (AI の利用量と待ち時間を抑える)。 */
export const MAX_SUGGEST_TABLES = 10;

interface Item {
  id: number;
  /** どのテーブルへの候補か (複数テーブル生成のとき、テーブルごとに区切って表示する)。 */
  table: string;
  name: string;
  description: string;
  /** 登録前に編集できる SQL。 */
  sql: string;
  checked: boolean;
}

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done" }
  | { kind: "raw"; raw: string; table: string }
  | { kind: "error"; message: string; refused: boolean; table: string }
  | { kind: "cancelled" };

type Tables = { kind: "loading" } | { kind: "ready"; names: string[] } | { kind: "error"; message: string };

/** 複数テーブルのうちどれで失敗したかを分かるようにする (1 件だけの失敗でも害は無い)。 */
function tableMessage(table: string, message: string): string {
  return table ? `${table}: ${message}` : message;
}

export interface AssertionSuggestModalProps {
  sessionId: string;
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  /** スキーマを読むデータベース。未指定は SQLite なら `main`。 */
  database: string | null;
  profile: Pick<ConnectionProfile, "id" | "group" | "is_production"> | null;
  /** 登録できた分を渡す (一覧へ反映する)。 */
  onRegistered: (saved: Assertion[]) => void;
  onClose: () => void;
}

/**
 * データ品質アサーションの候補を AI がスキーマから提案する Modal (#1477)。
 *
 * テーブルを選ぶと、列の型・NULL 可・キー・外部キー・列名・コメントから「違反行を返す
 * SELECT」を候補として返す。候補ごとに説明と SQL を見せ、チェックを付けたものだけを
 * 一括登録する (登録前に SQL を編集できる)。送るのはスキーマ情報だけで行データは送らない。
 * 登録できるのは `isReadOnlySql` を通る SQL だけ (バックエンドも保存時に再検証する)。
 * 送信前確認・中止・進捗は `AiImpactAnalysis` / `useAiStream` の流儀に揃える。
 */
export function AssertionSuggestModal(props: AssertionSuggestModalProps) {
  const t = useT();
  const locale = useLocale();
  const ai = useSettings().ai;
  const { confirm, dialog } = useConfirm();
  const stream = useAiStream({ idPrefix: "ai_assert" });
  const database = props.database ?? (props.driver === "sqlite" ? "main" : null);
  const [tables, setTables] = useState<Tables>({ kind: "loading" });
  const [pickedTables, setPickedTables] = useState<string[]>([]);
  const [tableFilter, setTableFilter] = useState("");
  // 生成中のテーブル (何番目 / 全何件)。
  const [progress, setProgress] = useState<{ table: string; index: number; total: number } | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [items, setItems] = useState<Item[]>([]);
  const [sends, setSends] = useState<string[]>([]);
  const [registering, setRegistering] = useState(false);
  const [registerErrors, setRegisterErrors] = useState<{ id: number; text: string }[]>([]);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!database) return;
    let alive = true;
    api
      .listTables(props.sessionId, database)
      .then((names) => {
        if (alive) setTables({ kind: "ready", names });
      })
      .catch((e) => {
        if (alive) setTables({ kind: "error", message: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [props.sessionId, database]);

  const running = state.kind === "running";
  const canGenerate =
    !!database && tables.kind === "ready" && pickedTables.length > 0 && !running && !registering;
  const selected = items.filter((i) => i.checked);
  const registrable = selected.filter((i) => isRegistrableSuggestionSql(i.sql, props.driver));
  const canRegister = registrable.length > 0 && !running && !registering;

  const toggleTable = (name: string) => {
    // 選択を変えたら、進行中の要求と前の候補を捨てる。
    stream.reset();
    setPickedTables((prev) =>
      prev.includes(name)
        ? prev.filter((n) => n !== name)
        : prev.length >= MAX_SUGGEST_TABLES
          ? prev
          : [...prev, name],
    );
    setItems([]);
    setState({ kind: "idle" });
    setProgress(null);
    setSends([]);
    setRegisterErrors([]);
  };

  const generate = async () => {
    if (!canGenerate || !database) return;
    // 二重実行 (連打・Cmd+Enter の連続) で 2 本のストリームが走らないよう、同期的に弾く。
    if (!stream.acquire()) return;
    try {
      await generateInner(database, pickedTables);
    } catch (e) {
      stream.release();
      setProgress(null);
      setState({ kind: "error", message: String(e), refused: false, table: "" });
    }
  };

  /** 1 テーブル分を要求して結果まで待つ。結末は `done` / 解釈不能 / 失敗 / 中止。 */
  const runTable = (
    db: string,
    targetTable: string,
    columns: AssertionSuggestColumn[],
    foreignKeys: AssertionSuggestForeignKey[],
    nextId: () => number,
  ): Promise<"done" | "stop"> =>
    new Promise((resolve) => {
      const parts = buildAssertionSuggestSystemParts({
        driver: props.driver,
        database: db,
        table: targetTable,
        columns,
        foreignKeys,
        locale,
      });
      void stream
        .start(
          {
            task: "assertionSuggest",
            systemCached: parts.cached,
            system: parts.variable || undefined,
            prompt: buildAssertionSuggestPrompt(targetTable),
            settings: toAiSnapshot(ai),
            format: ASSERTION_SUGGEST_FORMAT,
          },
          {
            parse: parseAssertionSuggestResponse,
            onDone: ({ parsed }) => {
              if (!parsed.ok) {
                setState({ kind: "raw", raw: parsed.raw, table: targetTable });
                resolve("stop");
                return;
              }
              setItems((prev) => [
                ...prev,
                ...parsed.suggestions.map((s) => ({
                  id: nextId(),
                  table: targetTable,
                  name: s.name,
                  description: s.description,
                  sql: s.sql,
                  // 読み取り専用と確認できた候補だけ初期選択にする。
                  checked: isRegistrableSuggestionSql(s.sql, props.driver),
                })),
              ]);
              resolve("done");
            },
            onError: (f) => {
              setState({ kind: "error", message: f.message, refused: f.refused, table: targetTable });
              resolve("stop");
            },
            onCancelled: () => {
              setState({ kind: "cancelled" });
              resolve("stop");
            },
          },
        )
        // アンマウントで購読されないまま終わった場合に待ち続けない。
        .then(() => {
          if (!stream.isMounted()) resolve("stop");
        });
    });

  const generateInner = async (db: string, targets: string[]) => {
    const dialect = dialectLabel(props.driver);
    // 確認ダイアログの前に、送る範囲の目安を出せるようスキーマを先に読む (行データは読まない)。
    setRegisterErrors([]);
    setState({ kind: "running" });
    const [described, allFks] = await Promise.all([
      Promise.all(
        targets.map(async (name) => ({
          name,
          columns: (await api.describeTable(props.sessionId, db, name)) as AssertionSuggestColumn[],
        })),
      ),
      api.foreignKeys(props.sessionId, db).catch(() => [] as AssertionSuggestForeignKey[]),
    ]);
    if (!stream.isMounted()) {
      stream.release();
      return;
    }
    // テーブルごとに「何を送るか」を 1 行ずつ出す。
    const sendsLines = described.map((d) =>
      t("assertAiSends", { table: d.name, columns: d.columns.length, dialect }),
    );
    setSends(sendsLines);
    // スキーマ情報だけを送るので、確認するのは本番接続のときだけ (AiSchemaDocModal と同じ)。
    if (props.profile?.is_production) {
      const ok = await confirm({
        title: t("assertAiConfirmTitle"),
        message: `${t("assertAiConfirmProdBody")}\n${sendsLines.join("\n")}`,
        confirmLabel: t("assertAiConfirmSend"),
        tone: "warning",
      });
      if (!ok) {
        stream.release();
        setState({ kind: "idle" });
        return;
      }
    }
    if (!stream.isMounted()) {
      stream.release();
      return;
    }
    setItems([]);
    let counter = 0;
    const nextId = () => counter++;
    let completed = true;
    for (const [i, d] of described.entries()) {
      // 2 テーブル目以降は、前のストリームが終わった時点で解放された実行権を取り直す。
      if (i > 0 && !stream.acquire()) {
        completed = false;
        break;
      }
      setProgress({ table: d.name, index: i + 1, total: described.length });
      const outcome = await runTable(db, d.name, d.columns, selectTableForeignKeys(allFks, d.name), nextId);
      if (outcome === "stop") {
        completed = false;
        break;
      }
    }
    if (!stream.isMounted()) return;
    setProgress(null);
    if (completed) setState({ kind: "done" });
  };

  const register = async () => {
    if (!canRegister) return;
    setRegistering(true);
    setRegisterErrors([]);
    const saved: Assertion[] = [];
    const failed = new Set<number>();
    const errors: { id: number; text: string }[] = [];
    for (const item of registrable) {
      const req = draftToRequest(
        suggestionToDraft({ name: item.name, sql: item.sql }, item.table, null),
        props.profile,
      );
      if (!req.ok) {
        failed.add(item.id);
        errors.push({ id: item.id, text: t("assertAiRegisterError", { name: item.name, error: req.error }) });
        continue;
      }
      try {
        saved.push(await api.saveAssertion(req.req));
      } catch (e) {
        failed.add(item.id);
        errors.push({ id: item.id, text: t("assertAiRegisterError", { name: item.name, error: String(e) }) });
      }
    }
    // 保存済みの候補は、登録中にモーダルが閉じられても親の一覧へ反映する (DB には既に入っている)。
    if (saved.length > 0) props.onRegistered(saved);
    if (!stream.isMounted()) return;
    setRegistering(false);
    if (errors.length === 0) {
      props.onClose();
      return;
    }
    // 登録できたものは一覧から外し、失敗したものだけ残して直せるようにする。
    const done = new Set(registrable.filter((i) => !failed.has(i.id)).map((i) => i.id));
    setItems((prev) => prev.filter((i) => !done.has(i.id)));
    setRegisterErrors(errors);
  };

  const update = (id: number, patch: Partial<Item>) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const tableNames = tables.kind === "ready" ? tables.names : [];
  // 絞り込み (大文字小文字を無視)。選択済みのテーブルは絞り込みで隠れても選択を保つ。
  const filterLower = tableFilter.trim().toLowerCase();
  const visibleTables = tableNames.filter(
    (n) => filterLower === "" || n.toLowerCase().includes(filterLower) || pickedTables.includes(n),
  );
  // 候補をテーブルごとに区切る (テーブルの初出順を保つ)。
  const groupedItems: { table: string; list: Item[] }[] = [];
  for (const it of items) {
    const g = groupedItems.find((x) => x.table === it.table);
    if (g) g.list.push(it);
    else groupedItems.push({ table: it.table, list: [it] });
  }
  const noDatabase = !database;
  const checkedCount = registrable.length;

  return (
    <>
      <Modal
        width="760px"
        onClose={props.onClose}
        initialFocusEl={() => filterRef.current}
        onSubmit={() => {
          void (items.length > 0 ? register() : generate());
        }}
        submitDisabled={items.length > 0 ? !canRegister : !canGenerate}
      >
        <ModalHeader onClose={props.onClose} closeLabel={t("assertAiClose")}>
          {t("assertAiTitle")}
        </ModalHeader>
        <ModalBody display="flex" flexDirection="column" gap="3.5" data-testid="assertion-suggest-modal">
          <chakra.p margin={0} fontSize="sm" color="app.textMuted">
            {t("assertAiDesc")}
          </chakra.p>
          {noDatabase && <Callout tone="warning">{t("assertAiNoDatabase")}</Callout>}
          {tables.kind === "error" && (
            <ErrorNote role="alert">{t("assertAiTablesError", { error: tables.message })}</ErrorNote>
          )}
          <FormSection>
            <FieldLabel htmlFor="assert-ai-table-filter">
              {t("assertAiTable")} ({pickedTables.length}/{MAX_SUGGEST_TABLES})
            </FieldLabel>
            <Input
              id="assert-ai-table-filter"
              ref={filterRef}
              type="search"
              value={tableFilter}
              placeholder={t("assertAiTablePlaceholder")}
              disabled={tables.kind !== "ready" || running || registering}
              onChange={(e) => setTableFilter(e.target.value)}
            />
            <Flex
              role="group"
              aria-label={t("assertAiTable")}
              gap="1.5"
              wrap="wrap"
              maxH="120px"
              overflowY="auto"
              data-testid="assertion-suggest-tables"
            >
              {visibleTables.map((n) => {
                const on = pickedTables.includes(n);
                return (
                  <Button
                    key={n}
                    type="button"
                    size="sm"
                    variant={on ? "primary" : "secondary"}
                    aria-pressed={on}
                    disabled={
                      tables.kind !== "ready" ||
                      running ||
                      registering ||
                      (!on && pickedTables.length >= MAX_SUGGEST_TABLES)
                    }
                    onClick={() => toggleTable(n)}
                  >
                    {n}
                  </Button>
                );
              })}
            </Flex>
            {pickedTables.length >= MAX_SUGGEST_TABLES && (
              <chakra.span color="app.textMuted" textStyle="caption">
                {t("assertAiTableLimit", { count: MAX_SUGGEST_TABLES })}
              </chakra.span>
            )}
          </FormSection>
          <Flex gap="2" align="center" wrap="wrap">
            <Button type="button" variant="secondary" disabled={!canGenerate} onClick={() => void generate()}>
              {t("assertAiGenerate")}
            </Button>
            {running && (
              <Button type="button" variant="secondary" onClick={stream.cancel}>
                {t("assertAiStop")}
              </Button>
            )}
          </Flex>
          {sends.length > 0 && (
            <Flex direction="column" gap="0.5">
              {sends.map((line) => (
                <chakra.span key={line} color="app.textMuted" textStyle="caption">
                  {line}
                </chakra.span>
              ))}
            </Flex>
          )}
          {running && (
            <AiStreamProgress
              stream={stream}
              previewText={false}
              waitingLabel={t("assertAiRunning", {
                table: progress?.table ?? "",
                current: progress?.index ?? 1,
                total: progress?.total ?? 1,
              })}
            />
          )}
          <Flex direction="column" gap="2.5" aria-live="polite">
            {state.kind === "raw" && (
              <Flex direction="column" gap="1">
                <ErrorNote role="alert">{t("assertAiParseError", { table: state.table })}</ErrorNote>
                <CodePreview wrap maxH="160px">
                  {state.raw}
                </CodePreview>
              </Flex>
            )}
            {state.kind === "error" &&
              (state.refused ? (
                <Callout tone="warning" role="alert">
                  {t("assertAiRefused", { message: tableMessage(state.table, state.message) })}
                </Callout>
              ) : (
                <ErrorNote role="alert">
                  {t("assertAiError", { message: tableMessage(state.table, state.message) })}
                </ErrorNote>
              ))}
            {state.kind === "cancelled" && (
              <Callout tone="info" role="status">
                {t("assertAiCancelled")}
              </Callout>
            )}
            {state.kind === "done" && items.length === 0 && (
              <Callout tone="info" role="status">
                {t("assertAiEmpty")}
              </Callout>
            )}
            {items.length > 0 && (
              <>
                <FieldLabel as="div">{t("assertAiSuggestions", { count: items.length })}</FieldLabel>
                <Callout tone="info" role="note">
                  {t("assertAiNote")}
                </Callout>
                {groupedItems.flatMap(({ table: groupTable, list }) => [
                  groupedItems.length > 1 ? (
                    <FieldLabel as="div" key={`group-${groupTable}`} data-testid="assertion-suggest-group">
                      {groupTable} ({list.length})
                    </FieldLabel>
                  ) : null,
                  ...list.map((item) => {
                    const ok = isRegistrableSuggestionSql(item.sql, props.driver);
                    return (
                      <Flex
                        key={item.id}
                        direction="column"
                        gap="1.5"
                        p="2.5"
                        border="1px solid"
                        borderColor="app.border"
                        borderRadius="md"
                        data-testid="assertion-suggestion"
                      >
                        <chakra.label display="flex" alignItems="center" gap="2" cursor="pointer">
                          <Checkbox
                            checked={item.checked && ok}
                            disabled={!ok || registering}
                            aria-label={t("assertAiPick", { name: item.name })}
                            onChange={(e) => update(item.id, { checked: e.target.checked })}
                          />
                          <chakra.span fontWeight={600}>{item.name}</chakra.span>
                        </chakra.label>
                        {item.description && (
                          <chakra.span fontSize="sm" color="app.textMuted">
                            {item.description}
                          </chakra.span>
                        )}
                        <FieldLabel htmlFor={`assert-ai-sql-${item.id}`}>{t("assertAiSqlLabel")}</FieldLabel>
                        <Textarea
                          id={`assert-ai-sql-${item.id}`}
                          rows={3}
                          value={item.sql}
                          disabled={registering}
                          fontFamily="mono"
                          spellCheck={false}
                          onChange={(e) => {
                            const sql = e.target.value;
                            // 読み取り専用でなくなった候補は、選択も外す。
                            update(item.id, {
                              sql,
                              checked: isRegistrableSuggestionSql(sql, props.driver) ? item.checked : false,
                            });
                          }}
                        />
                        {!ok && <ErrorNote role="alert">{t("assertAiNotReadOnly")}</ErrorNote>}
                        {ok && (
                          <SqlCountCheck
                            sessionId={props.sessionId}
                            database={database}
                            driver={props.driver}
                            sql={item.sql}
                            mode="violations"
                            disabled={registering}
                          />
                        )}
                      </Flex>
                    );
                  }),
                ])}
              </>
            )}
            <AiUsageNote event={stream.done} />
            {registerErrors.map((e) => (
              <ErrorNote key={e.id} role="alert">
                {e.text}
              </ErrorNote>
            ))}
          </Flex>
        </ModalBody>
        <ModalFooter>
          <div style={{ flex: 1 }} />
          <Button type="button" variant="secondary" onClick={props.onClose}>
            {t("assertAiClose")}
          </Button>
          <Button type="button" variant="primary" disabled={!canRegister} onClick={() => void register()}>
            {t("assertAiRegister", { count: checkedCount })}
          </Button>
        </ModalFooter>
      </Modal>
      {dialog}
    </>
  );
}
