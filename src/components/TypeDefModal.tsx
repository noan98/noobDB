import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api, type TableColumnInfo } from "../api/tauri";
import { useT, type I18nKey } from "../i18n";
import { loadTypeDefsPrefs, saveTypeDefsPrefs, typeDefsScope } from "../inputMemory";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { CodePreview, ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Button, Checkbox, Input, PressableButton, Radio } from "./ui";
import { copyToClipboard } from "./clipboard";
import { useToast } from "./Toast";
import {
  buildPgColumnTypesQuery,
  generateTypeDefs,
  namingApplies,
  TYPE_DEF_LANGS,
  TYPE_DEF_NAMINGS,
  type TypeDefLang,
  type TypeDefNaming,
  type TypeDefTable,
} from "./typeDefGen";
import { buildAllowedValuesQueries, collectAllowedValues } from "./valuePicker";

const LANG_LABEL: Record<TypeDefLang, I18nKey> = {
  typescript: "typeDefLangTypescript",
  typescriptZod: "typeDefLangTypescriptZod",
  go: "typeDefLangGo",
  rust: "typeDefLangRust",
  python: "typeDefLangPython",
  pythonPydantic: "typeDefLangPythonPydantic",
};
const NAMING_LABEL: Record<TypeDefNaming, I18nKey> = {
  snake: "typeDefNamingSnake",
  camel: "typeDefNamingCamel",
};
const PICKER_MAX_ROWS = 200;

interface Props {
  sessionId: string;
  driver: string;
  database: string;
  /** 最初に選択しておくテーブル。空ならモーダル内で選ぶ (コマンドパレットからの起動)。 */
  tables: string[];
  profileId?: string;
  onClose: () => void;
}

/** PostgreSQL で追加の読み取りクエリが要る列 (ENUM らしい USER-DEFINED / 配列の ARRAY) を持つか。 */
function pgLookupNeeds(cols: TableColumnInfo[]): { enums: boolean; arrays: boolean } {
  const types = cols.map((c) => c.data_type.toUpperCase());
  return { enums: types.includes("USER-DEFINED"), arrays: types.includes("ARRAY") };
}

interface Loaded {
  columns: Map<string, TableColumnInfo[]>;
  comments: Map<string, string>;
}

/**
 * テーブル定義から TypeScript / Go / Rust / Python の型定義を生成してコピーする (#2411)。
 * 既存の `describeDatabase` / `listTableComments` と、PostgreSQL の ENUM ラベルを引く読み取りクエリ
 * (`valuePicker.ts`) だけを使い、新しい IPC は持たない。生成は `typeDefGen.ts` の純関数。
 */
export function TypeDefModal({ sessionId, driver, database, tables, profileId, onClose }: Props) {
  const t = useT();
  const toast = useToast();
  const scope = typeDefsScope(profileId);
  const [remembered] = useState(() => (profileId ? loadTypeDefsPrefs(scope) : null));
  const [lang, setLang] = useState<TypeDefLang>(remembered?.lang ?? "typescript");
  const [naming, setNaming] = useState<TypeDefNaming>(remembered?.naming ?? "snake");
  const [loaded, setLoaded] = useState<Loaded | { error: string } | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(tables));
  const [filter, setFilter] = useState("");
  // PostgreSQL の ENUM ラベル ((テーブル) → (列 → 値))。取得済みのテーブルだけ入る。
  const [pgEnums, setPgEnums] = useState<Map<string, Map<string, string[]>>>(new Map());
  // PostgreSQL の配列列の型名 (`integer[]` など、(テーブル) → (列 → 型名))。information_schema は `ARRAY` としか返さない。
  const [pgArrays, setPgArrays] = useState<Map<string, Map<string, string>>>(new Map());
  const [enumFailed, setEnumFailed] = useState(false);
  // 追加クエリが終わった (成功・失敗を問わない) テーブル。取得中はコピーを止める。
  const [lookupDone, setLookupDone] = useState<ReadonlySet<string>>(new Set());
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.describeDatabase(sessionId, database),
      api.listTableComments(sessionId, database).catch(() => []),
    ])
      .then(([described, comments]) => {
        if (!alive) return;
        setLoaded({
          columns: new Map(described.map((tb) => [tb.name, tb.columns])),
          comments: new Map(comments.filter((c) => c.comment).map((c) => [c.name, c.comment as string])),
        });
      })
      .catch((e) => {
        if (alive) setLoaded({ error: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [sessionId, database]);

  const ready = loaded && !("error" in loaded) ? loaded : null;
  const allNames = useMemo(() => (ready ? [...ready.columns.keys()] : []), [ready]);
  const selectedNames = useMemo(() => allNames.filter((n) => selected.has(n)), [allNames, selected]);

  // 選択したテーブルのうち ENUM らしい列 (USER-DEFINED) / 配列列 (ARRAY) を持つものだけ、PostgreSQL へ追加で問い合わせる。
  useEffect(() => {
    if (!ready || driver !== "postgres") return;
    for (const name of selectedNames) {
      if (requested.current.has(name)) continue;
      const cols = ready.columns.get(name) ?? [];
      const need = pgLookupNeeds(cols);
      if (!need.enums && !need.arrays) continue;
      requested.current.add(name);
      const run = (sql: string) =>
        api.runLookupQuery({ sessionId, sql, database, rowCap: 1000, queryTimeoutSecs: 5 });
      const tasks: Promise<void>[] = [];
      const enumQuery = need.enums
        ? buildAllowedValuesQueries(driver, database, name).find((x) => x.purpose === "pgEnum")
        : undefined;
      if (enumQuery) {
        tasks.push(
          run(enumQuery.sql)
            .then((res) => {
              const m = collectAllowedValues(driver, cols, res.rows);
              const byCol = new Map<string, string[]>();
              for (const [col, a] of m) if (a.kind === "enum") byCol.set(col, a.values);
              setPgEnums((cur) => new Map(cur).set(name, byCol));
            })
            .catch(() => setEnumFailed(true)),
        );
      }
      if (need.arrays) {
        tasks.push(
          run(buildPgColumnTypesQuery(database, name))
            .then((res) => {
              const byCol = new Map<string, string>();
              for (const row of res.rows)
                if (row[0] != null && row[1] != null) byCol.set(String(row[0]), String(row[1]));
              setPgArrays((cur) => new Map(cur).set(name, byCol));
            })
            .catch(() => setEnumFailed(true)),
        );
      }
      void Promise.all(tasks).then(() => setLookupDone((cur) => new Set(cur).add(name)));
    }
  }, [ready, driver, database, sessionId, selectedNames]);

  const lookupPending = useMemo(() => {
    if (!ready || driver !== "postgres") return false;
    return selectedNames.some((name) => {
      const need = pgLookupNeeds(ready.columns.get(name) ?? []);
      return (need.enums || need.arrays) && !lookupDone.has(name);
    });
  }, [ready, driver, selectedNames, lookupDone]);

  const defs = useMemo<TypeDefTable[]>(
    () =>
      selectedNames.map((name) => ({
        name,
        comment: ready?.comments.get(name) ?? null,
        columns: (ready?.columns.get(name) ?? []).map((c) => ({
          name: c.name,
          data_type: pgArrays.get(name)?.get(c.name) ?? c.data_type,
          nullable: c.nullable,
          comment: c.comment ?? null,
          enumValues: pgEnums.get(name)?.get(c.name) ?? null,
        })),
      })),
    [selectedNames, ready, pgEnums, pgArrays],
  );
  const previewContent = useMemo(
    () => generateTypeDefs(defs, { driver, lang, naming }),
    [defs, driver, lang, naming],
  );
  const canCopy = previewContent.length > 0 && !lookupPending;

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? allNames.filter((n) => n.toLowerCase().includes(f)) : allNames;
  }, [allNames, filter]);

  const toggle = (name: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (!next.delete(name)) next.add(name);
      return next;
    });

  const submit = async () => {
    if (!canCopy) return;
    if (await copyToClipboard(previewContent)) {
      if (profileId) saveTypeDefsPrefs(scope, { lang, naming });
      toast.success(t("typeDefCopied", { count: defs.length }));
      onClose();
    } else {
      toast.error(t("clipboardCopyFailed"));
    }
  };

  const radioRow = <V extends string>(
    group: string,
    values: readonly V[],
    current: V,
    set: (v: V) => void,
    label: (v: V) => string,
    disabled = false,
  ) => (
    <chakra.div role="radiogroup" aria-label={group} display="flex" flexWrap="wrap" gap="4">
      {values.map((v) => (
        <chakra.label key={v} display="inline-flex" alignItems="center" gap="1.5" userSelect="none">
          <Radio
            name={group}
            value={v}
            checked={current === v}
            onChange={() => set(v)}
            disabled={disabled}
            m={0}
          />
          <chakra.span fontSize="md">{label(v)}</chakra.span>
        </chakra.label>
      ))}
    </chakra.div>
  );

  return (
    <Modal onSubmit={() => void submit()} submitDisabled={!canCopy} width="640px" onClose={onClose}>
      <ModalHeader onClose={onClose} closeLabel={t("typeDefClose")}>
        {t("typeDefTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {loaded === null && (
          <chakra.div role="status" textStyle="caption">
            {t("typeDefLoading")}
          </chakra.div>
        )}
        {loaded && "error" in loaded && (
          <ErrorNote role="alert">{t("typeDefLoadError", { error: loaded.error })}</ErrorNote>
        )}
        {ready && (
          <>
            <FormSection>
              <FieldLabel as="div">{t("typeDefLanguage")}</FieldLabel>
              {radioRow("type-def-lang", TYPE_DEF_LANGS, lang, setLang, (v) => t(LANG_LABEL[v]))}
            </FormSection>
            <FormSection>
              <FieldLabel as="div">{t("typeDefNaming")}</FieldLabel>
              {radioRow(
                "type-def-naming",
                TYPE_DEF_NAMINGS,
                naming,
                setNaming,
                (v) => t(NAMING_LABEL[v]),
                !namingApplies(lang),
              )}
              {!namingApplies(lang) && (
                <chakra.span textStyle="caption">{t("typeDefNamingFixed")}</chakra.span>
              )}
            </FormSection>
            <FormSection>
              <FieldLabel as="div">{t("typeDefTables")}</FieldLabel>
              <Input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("typeDefTablesFilter")}
                aria-label={t("typeDefTablesFilter")}
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
                {filtered.slice(0, PICKER_MAX_ROWS).map((name) => (
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
                    <Checkbox checked={selected.has(name)} onChange={() => toggle(name)} />
                    <chakra.span fontSize="sm" fontFamily="mono" minW={0} truncate>
                      {name}
                    </chakra.span>
                  </chakra.label>
                ))}
              </chakra.div>
              <chakra.span textStyle="caption">
                {t("typeDefTablesSelectedCount", { count: selectedNames.length })}
              </chakra.span>
            </FormSection>
            <FormSection>
              <FieldLabel as="div">{t("typeDefPreview")}</FieldLabel>
              {previewContent.length > 0 ? (
                <CodePreview minH="80px" maxH="280px" aria-label={t("typeDefPreview")}>
                  {previewContent}
                </CodePreview>
              ) : (
                <chakra.span textStyle="caption">{t("typeDefNoTables")}</chakra.span>
              )}
              {enumFailed && <chakra.span textStyle="caption">{t("typeDefEnumNote")}</chakra.span>}
            </FormSection>
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("typeDefClose")}
        </Button>
        <PressableButton type="button" variant="primary" disabled={!canCopy} onClick={() => void submit()}>
          {t("typeDefCopy")}
        </PressableButton>
      </ModalFooter>
    </Modal>
  );
}
