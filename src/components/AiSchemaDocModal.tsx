import { useEffect, useMemo, useRef, useState } from "react";
import { chakra, Flex } from "@chakra-ui/react";
import { downloadDir, join } from "@tauri-apps/api/path";
import { save } from "@tauri-apps/plugin-dialog";
import { api, type SchemaObject } from "../api/tauri";
import { toAiSnapshot } from "../ai/aiSettings";
import { useAiStream } from "../ai/useAiStream";
import { dialectLabel } from "../ai/errorExplain";
import { approxKb } from "../ai/nl2sql";
import {
  assembleSchemaDoc,
  buildSchemaDocHeader,
  buildSchemaDocPrompt,
  buildSchemaDocSystem,
  defaultSchemaDocFilename,
  filterForeignKeysInScope,
  resolveSchemaDocScope,
  SCHEMA_DOC_MAX_PROMPT_BYTES,
  schemaDocConcurrency,
  selectDocObjects,
  summarizeSchemaDocSend,
  type SchemaDocContext,
  type SchemaDocForeignKey,
  type SchemaDocScopeMode,
  utf8Bytes,
  type SchemaDocTable,
} from "../ai/schemaDoc";
import { useLocale, useT } from "../i18n";
import { useSettings } from "../settings";
import { Button, Checkbox, Input, Radio } from "./ui";
import { Callout } from "./Callout";
import { useConfirm } from "./ConfirmDialog";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { mapLimited } from "./mapLimited";
import { AiStreamProgress } from "./AiStreamProgress";
import { AiUsageNote } from "./AiUsageNote";
import { Spinner } from "./Spinner";
import { useToast } from "./Toast";
import { useCopyFeedback } from "./useCopyFeedback";

type Loaded =
  | { kind: "loading" }
  | {
      kind: "ready";
      tables: SchemaDocTable[];
      foreignKeys: SchemaDocForeignKey[];
      objects: SchemaObject[];
      /** 外部キーを取得できなかった (関係が含まれない)。 */
      fkFailed: boolean;
    }
  | { kind: "error"; message: string };

type State =
  | { kind: "idle" }
  | { kind: "collecting" }
  | { kind: "running"; sentKb: number }
  | { kind: "done"; doc: string; truncated: boolean }
  | { kind: "tooBig"; kb: number }
  | { kind: "error"; message: string; refused: boolean }
  | { kind: "cancelled" };

export interface AiSchemaDocModalProps {
  sessionId: string;
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  /** ドキュメント化するデータベース (SQLite は `main`)。 */
  database: string;
  /** 冒頭注記に入れる接続プロファイル名 (ホスト名等は入れない)。 */
  profileName: string;
  isProduction: boolean;
  /** ER 図で選択中のテーブル。あれば「選択テーブルとその参照先」を初期スコープにする。 */
  initialTables?: readonly string[];
  onClose: () => void;
}

/**
 * スキーマドキュメントを AI で生成する Modal (#696)。テーブル / 列の名前・型・キー・コメント、
 * インデックス、外部キー、ビュー / ルーチンの定義だけを送る。行データ・サンプル値・列の
 * デフォルト値は送らない。生成物は Markdown の生テキストで逐次表示し、コピー / `.md` 保存できる。
 * 冒頭の生成日時・対象接続・AI 推定の注記はモデルに書かせず、フロントで付ける。AI 無効時は何も描かない。
 */
export function AiSchemaDocModal(props: AiSchemaDocModalProps) {
  const t = useT();
  const locale = useLocale();
  const toast = useToast();
  const ai = useSettings().ai;
  const { confirm, dialog } = useConfirm();
  const { copied, copy } = useCopyFeedback();
  const initial = props.initialTables ?? [];
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [mode, setMode] = useState<SchemaDocScopeMode>(initial.length > 0 ? "selected" : "all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initial));
  const [filter, setFilter] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const stream = useAiStream({ idPrefix: "ai_schemadoc" });
  // 定義の収集中 (まだストリームが無い間) に中止されたか。ストリーム開始後の中止はフックが扱う。
  const collectAbortRef = useRef(false);

  const { sessionId, database } = props;

  useEffect(() => {
    let alive = true;
    setLoaded({ kind: "loading" });
    let fkFailed = false;
    Promise.all([
      api.describeDatabase(sessionId, database),
      // 以下は補助情報。取れなくてもドキュメント生成は続ける。
      api.foreignKeys(sessionId, database).catch(() => {
        fkFailed = true;
        return [];
      }),
      api.listSchemaObjects(sessionId, database).catch(() => [] as SchemaObject[]),
      api.listTableComments(sessionId, database).catch(() => []),
    ])
      .then(([described, fks, objects, comments]) => {
        if (!alive) return;
        const viewNames = new Set(
          objects.filter((o) => o.kind === "view" || o.kind === "materialized_view").map((o) => o.name),
        );
        const commentByTable = new Map(comments.map((c) => [c.name, c.comment]));
        setLoaded({
          kind: "ready",
          tables: described.map((tb) => ({
            name: tb.name,
            isView: viewNames.has(tb.name),
            comment: commentByTable.get(tb.name) ?? null,
            columns: tb.columns.map((c) => ({
              name: c.name,
              data_type: c.data_type,
              nullable: c.nullable,
              key: c.key,
              comment: c.comment ?? null,
            })),
            indexes: [],
          })),
          foreignKeys: fks.map((f) => ({
            table: f.table,
            column: f.column,
            referenced_table: f.referenced_table,
            referenced_column: f.referenced_column,
          })),
          objects,
          fkFailed,
        });
      })
      .catch((e) => {
        if (alive) setLoaded({ kind: "error", message: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [sessionId, database]);

  const allNames = useMemo(
    () => (loaded.kind === "ready" ? loaded.tables.map((x) => x.name) : []),
    [loaded],
  );
  const scopeNames = useMemo(
    () =>
      loaded.kind === "ready"
        ? resolveSchemaDocScope({
            allTables: allNames,
            selected: [...selected],
            foreignKeys: loaded.foreignKeys,
            mode,
          })
        : [],
    [loaded, allNames, selected, mode],
  );
  const scopedTables = useMemo(() => {
    if (loaded.kind !== "ready") return [];
    const set = new Set(scopeNames);
    return loaded.tables.filter((x) => set.has(x.name));
  }, [loaded, scopeNames]);
  const scopedFks = useMemo(
    () => (loaded.kind === "ready" ? filterForeignKeysInScope(loaded.foreignKeys, scopeNames) : []),
    [loaded, scopeNames],
  );
  const summary = useMemo(
    () => summarizeSchemaDocSend({ tables: scopedTables, foreignKeys: scopedFks, objects: [] }),
    [scopedTables, scopedFks],
  );
  const filteredNames = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? allNames.filter((n) => n.toLowerCase().includes(q)) : allNames;
  }, [allNames, filter]);

  const sendsLine =
    loaded.kind === "ready" && summary.tableCount > 0
      ? t(mode === "all" ? "aiSchemaDocSends" : "aiSchemaDocSendsSelected", {
          database,
          tables: summary.tableCount,
          columns: summary.columnCount,
          fks: summary.fkCount,
          kb: approxKb(summary.approxChars),
          dialect: dialectLabel(props.driver),
        })
      : null;

  const busy = state.kind === "collecting" || state.kind === "running";
  const emptySelection = mode === "selected" && selected.size === 0;
  const canGenerate = loaded.kind === "ready" && summary.tableCount > 0 && !emptySelection && !busy;

  const toggleTable = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // 収集中も送信後も同じ「中止」ボタンから止める。
  const cancelRun = () => {
    collectAbortRef.current = true;
    stream.cancel();
  };

  const run = async () => {
    if (loaded.kind !== "ready" || !canGenerate) return;
    // 二重実行 (連打・Cmd+Enter の連続) で 2 本のストリームが走らないよう、同期的に弾く。
    if (!stream.acquire()) return;
    try {
      await runInner(loaded);
    } catch (e) {
      stream.release();
      if (stream.isMounted()) setState({ kind: "error", message: String(e), refused: false });
    }
  };

  const runInner = async (ready: Extract<Loaded, { kind: "ready" }>) => {
    if (props.isProduction) {
      const ok = await confirm({
        title: t("aiSchemaDocConfirmTitle"),
        message: `${t("aiSchemaDocConfirmBody")}\n${sendsLine ?? ""}`,
        confirmLabel: t("aiSchemaDocConfirmSend"),
        tone: "warning",
      });
      if (!ok) {
        stream.release();
        return;
      }
    }
    collectAbortRef.current = false;
    setState({ kind: "collecting" });
    // インデックスとビュー / ルーチンの定義はテーブル数ぶんの呼び出しになるので、並列度を抑える。
    const limit = schemaDocConcurrency(scopedTables.length);
    const withIndexes = await mapLimited(scopedTables, limit, async (tb) => {
      if (collectAbortRef.current || !stream.isMounted() || tb.isView) return tb;
      const indexes = await api.listIndexes(sessionId, database, tb.name).catch(() => []);
      return { ...tb, indexes };
    });
    const targets = selectDocObjects(ready.objects, mode === "all" ? null : scopeNames);
    const objects = await mapLimited(targets, limit, async (o) => {
      if (collectAbortRef.current || !stream.isMounted()) return { kind: o.kind, name: o.name, definition: null };
      const definition = await api
        .getObjectDefinition(sessionId, database, o.kind, o.name, o.id)
        .catch(() => null);
      return { kind: o.kind, name: o.name, definition };
    });
    if (!stream.isMounted()) {
      stream.release();
      return;
    }
    if (collectAbortRef.current) {
      stream.release();
      setState({ kind: "cancelled" });
      return;
    }
    const context: SchemaDocContext = { tables: withIndexes, foreignKeys: scopedFks, objects };
    const header = buildSchemaDocHeader({
      generatedAt: new Date(),
      profileName: props.profileName,
      database,
      driver: props.driver,
      locale,
    });
    const system = buildSchemaDocSystem({ driver: props.driver, database, locale, context });
    const prompt = buildSchemaDocPrompt(locale);
    // 実際に送るバイト数。バックエンドの上限を超えるなら送らずに絞り込みを促す。
    const sentBytes = utf8Bytes(system) + utf8Bytes(prompt);
    if (sentBytes > SCHEMA_DOC_MAX_PROMPT_BYTES) {
      stream.release();
      setState({ kind: "tooBig", kb: approxKb(sentBytes) });
      return;
    }
    const sentKb = approxKb(sentBytes);
    setState({ kind: "running", sentKb });
    await stream.start(
      {
        task: "schemaDoc",
        system,
        prompt,
        settings: toAiSnapshot(ai),
      },
      {
        onDone: ({ text, event }) =>
          setState({
            kind: "done",
            doc: assembleSchemaDoc(header, text),
            truncated: event.stopReason === "max_tokens",
          }),
        onError: (f) => setState({ kind: "error", message: f.message, refused: f.refused }),
        onCancelled: () => setState({ kind: "cancelled" }),
      },
    );
  };

  const doc = state.kind === "done" ? state.doc : null;

  const handleSave = async () => {
    if (doc === null) return;
    try {
      let defaultPath = defaultSchemaDocFilename(database);
      try {
        defaultPath = await join(await downloadDir(), defaultPath);
      } catch {
        // ダウンロードフォルダが解決できない環境ではファイル名のみで開く。
      }
      const picked = await save({
        defaultPath,
        title: t("aiSchemaDocSaveTitle"),
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (typeof picked !== "string" || !picked) return;
      await api.writeTextFile(picked, doc);
      toast.success(t("aiSchemaDocSaved", { path: picked }));
    } catch (e) {
      toast.error(t("aiSchemaDocSaveError", { error: String(e) }));
    }
  };

  if (!ai.enabled) return null;

  return (
    <>
      <Modal
        width="720px"
        onClose={props.onClose}
        onSubmit={() => {
          void run();
        }}
        submitDisabled={!canGenerate}
      >
        <ModalHeader onClose={props.onClose} closeLabel={t("aiSchemaDocClose")}>
          {t("aiSchemaDocTitle", { database })}
        </ModalHeader>
        <ModalBody display="flex" flexDirection="column" gap="4" data-testid="ai-schema-doc-modal">
          {loaded.kind === "loading" && (
            <Flex align="center" gap="2" color="app.textMuted" fontSize="sm">
              <Spinner size={12} />
              {t("aiSchemaDocLoading")}
            </Flex>
          )}
          {loaded.kind === "error" && (
            <ErrorNote role="alert">{t("aiSchemaDocLoadError", { message: loaded.message })}</ErrorNote>
          )}
          {loaded.kind === "ready" && allNames.length === 0 && (
            <Callout tone="warning" role="status">
              {t("aiSchemaDocEmpty")}
            </Callout>
          )}
          {loaded.kind === "ready" && allNames.length > 0 && (
            <FormSection>
              <FieldLabel as="div">{t("aiSchemaDocScope")}</FieldLabel>
              <chakra.div role="radiogroup" aria-label={t("aiSchemaDocScope")} display="flex" gap="4">
                {(["all", "selected"] as const).map((m) => (
                  <chakra.label
                    key={m}
                    display="inline-flex"
                    alignItems="center"
                    gap="1.5"
                    cursor="pointer"
                    userSelect="none"
                  >
                    <Radio
                      name="ai-schema-doc-scope"
                      value={m}
                      checked={mode === m}
                      onChange={() => setMode(m)}
                      disabled={busy}
                      m={0}
                    />
                    <chakra.span fontSize="md">
                      {m === "all" ? t("aiSchemaDocScopeAll") : t("aiSchemaDocScopeSelected")}
                    </chakra.span>
                  </chakra.label>
                ))}
              </chakra.div>
              {mode === "selected" && (
                <>
                  <Input
                    type="text"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder={t("aiSchemaDocFilterPlaceholder")}
                    aria-label={t("aiSchemaDocFilterPlaceholder")}
                    disabled={busy}
                  />
                  <chakra.div
                    maxH="160px"
                    overflowY="auto"
                    border="1px solid"
                    borderColor="app.border"
                    borderRadius="md"
                    p="1.5"
                    display="flex"
                    flexDirection="column"
                  >
                    {filteredNames.map((name) => {
                      const auto = !selected.has(name) && scopeNames.includes(name);
                      return (
                        <chakra.label
                          key={name}
                          display="flex"
                          alignItems="center"
                          gap="2"
                          py="0.5"
                          px="1"
                          borderRadius="sm"
                          cursor="pointer"
                          userSelect="none"
                          _hover={{ bg: "app.rowHover" }}
                        >
                          <Checkbox
                            checked={selected.has(name)}
                            onChange={() => toggleTable(name)}
                            disabled={busy}
                          />
                          <chakra.span fontSize="sm" fontFamily="mono" minW={0} truncate>
                            {name}
                          </chakra.span>
                          {auto && (
                            <chakra.span
                              flex="none"
                              fontSize="2xs"
                              px="1.5"
                              borderRadius="sm"
                              bg="app.rowHover"
                              color="app.textMuted"
                            >
                              {t("aiSchemaDocReferenced")}
                            </chakra.span>
                          )}
                        </chakra.label>
                      );
                    })}
                  </chakra.div>
                  <chakra.span fontSize="xs" color="app.textMuted">
                    {emptySelection
                      ? t("aiSchemaDocNoSelection")
                      : t("aiSchemaDocSelectedCount", { selected: selected.size, effective: scopeNames.length })}
                  </chakra.span>
                </>
              )}
              {sendsLine && (
                <chakra.span color="app.textMuted" fontSize="xs" data-testid="ai-schema-doc-sends">
                  {sendsLine}
                </chakra.span>
              )}
            </FormSection>
          )}
          {loaded.kind === "ready" && loaded.fkFailed && (
            <Callout tone="info" role="status">
              {t("aiSchemaDocFkMissing")}
            </Callout>
          )}
          {summary.level === "tooLarge" && (
            <Callout tone="warning" role="status">
              {t("aiSchemaDocLargeSchema", { tables: summary.tableCount, kb: approxKb(summary.approxChars) })}
            </Callout>
          )}
          {state.kind === "collecting" && (
            <Flex align="center" gap="2" color="app.textMuted" fontSize="sm" aria-live="polite">
              <Spinner size={12} />
              {t("aiSchemaDocCollecting")}
              <Button type="button" variant="secondary" size="sm" onClick={cancelRun}>
                {t("aiSchemaDocCancel")}
              </Button>
            </Flex>
          )}
          {state.kind === "running" && (
            <Flex align="center" gap="2" fontSize="sm" wrap="wrap">
              <AiStreamProgress
                stream={stream}
                previewText={false}
                waitingLabel={t("aiSchemaDocRunning", { kb: state.sentKb })}
              />
              <Button type="button" variant="secondary" size="sm" onClick={cancelRun}>
                {t("aiSchemaDocCancel")}
              </Button>
            </Flex>
          )}
          {(state.kind === "running" || state.kind === "done") && (
            <FormSection>
              <FieldLabel as="div">{t("aiSchemaDocResult")}</FieldLabel>
              <CodePreview wrap maxH="320px" aria-label={t("aiSchemaDocResult")}>
                {state.kind === "running" ? stream.text : state.doc}
              </CodePreview>
            </FormSection>
          )}
          <AiUsageNote event={stream.done} />
          {state.kind === "error" &&
            (state.refused ? (
              <Callout tone="warning" role="alert">
                {t("aiSchemaDocRefused", { message: state.message })}
              </Callout>
            ) : (
              <ErrorNote role="alert">{t("aiSchemaDocError", { message: state.message })}</ErrorNote>
            ))}
          {state.kind === "done" && state.truncated && (
            <Callout tone="warning" role="status">
              {t("aiSchemaDocTruncated")}
            </Callout>
          )}
          {state.kind === "tooBig" && (
            <ErrorNote role="alert">
              {t("aiSchemaDocTooBig", { kb: state.kb, limit: SCHEMA_DOC_MAX_PROMPT_BYTES / 1024 })}
            </ErrorNote>
          )}
          {state.kind === "cancelled" && (
            <Callout tone="info" role="status">
              {t("aiSchemaDocCancelled")}
            </Callout>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={doc === null}
            onClick={() => {
              if (doc !== null) void copy(doc);
            }}
          >
            {copied ? t("aiSchemaDocCopied") : t("aiSchemaDocCopy")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={doc === null}
            onClick={() => {
              void handleSave();
            }}
          >
            {t("aiSchemaDocSave")}
          </Button>
          <div style={{ flex: 1 }} />
          <Button type="button" variant="secondary" onClick={props.onClose}>
            {t("aiSchemaDocClose")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!canGenerate}
            onClick={() => {
              void run();
            }}
          >
            {t("aiSchemaDocGenerate")}
          </Button>
        </ModalFooter>
      </Modal>
      {dialog}
    </>
  );
}
