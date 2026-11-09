import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api, type ExtensionDependent, type ExtensionInfo, type ExtensionsOverview } from "../api/tauri";
import { resolveErrorHint } from "../errorHints";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { ExtensionDependents } from "./ExtensionDependents";
import {
  buildExtensionSql,
  isDestructiveExtensionAction,
  isPreloaded,
  matchesExtensionFilter,
  needsPreload,
  type ExtensionAction,
  type ExtensionFilter,
} from "./extensionSql";
import { ListboxSelect } from "./ListboxSelect";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { Spinner } from "./Spinner";
import { SqlPreview } from "./SqlPreview";
import { Button, Checkbox, Input, PressableButton } from "./ui";

/**
 * PostgreSQL の拡張機能 (EXTENSION) の一覧・導入・更新・削除ダイアログ (#2160)。
 * 導入済み (バージョン / スキーマ) とサーバが提供できるもの (既定のバージョン / 更新の可否) を並べ、
 * 操作を選ぶと `CREATE EXTENSION` / `ALTER EXTENSION ... UPDATE` / `DROP EXTENSION` をプレビューしてから実行する。
 * 実行は呼び出し側 (App) が通常のクエリ経路で行う (read_only の拒否はバックエンド。ここでは先回りして押せなくする)。
 * 失敗したときは、その理由を既存のエラーヒント (権限不足など) を添えて表示する。
 */
interface Props {
  sessionId: string;
  readOnly: boolean;
  /**
   * SQL を実行する。失敗は throw する (このダイアログがエラーとヒントを表示する)。
   * 実行前の確認 (本番の書き込み承認・型入力など) がキャンセルされて実行しなかったときは "cancelled" を返す。
   */
  onExecute: (sql: string, action: ExtensionAction, name: string) => Promise<void | "cancelled">;
  onClose: () => void;
}

interface Step {
  action: ExtensionAction;
  ext: ExtensionInfo;
}

export function ExtensionsModal({ sessionId, readOnly, onExecute, onClose }: Props) {
  const t = useT();
  const [overview, setOverview] = useState<ExtensionsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ExtensionFilter>("all");
  const [step, setStep] = useState<Step | null>(null);
  const [schema, setSchema] = useState("");
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  // 削除の確認画面で出す依存オブジェクト (#2177)。null は取得中。失敗しても削除は妨げない。
  // 取得した拡張名と一緒に持つ (拡張を切り替えた直後に前の拡張の一覧が見えないように)。
  const [depsState, setDepsState] = useState<{
    name: string;
    data: ExtensionDependent[] | null;
    error: string | null;
  } | null>(null);
  const mountedRef = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const o = await api.listExtensions(sessionId);
      if (!mountedRef.current) return;
      setOverview(o);
      setLoadError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setLoadError(t("extensionsLoadError", { error: String(e) }));
      setOverview((prev) => prev ?? { extensions: [], shared_preload_libraries: [] });
    }
  }, [sessionId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const dropName = step?.action === "drop" ? step.ext.name : null;
  useEffect(() => {
    if (dropName === null) return;
    let alive = true;
    api
      .listExtensionDependents(sessionId, dropName)
      .then((d) => {
        if (alive) setDepsState({ name: dropName, data: d, error: null });
      })
      .catch((e) => {
        if (alive) setDepsState({ name: dropName, data: null, error: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [sessionId, dropName]);

  const deps = depsState !== null && depsState.name === dropName ? depsState : null;
  const dependents = deps?.data ?? null;
  const dependentsError = deps?.error ?? null;
  // CASCADE なしで依存があるときは、ExtensionDependents の「このままでは失敗します」が危険帯を兼ねる。
  const failsWithoutCascade = !cascade && dependents !== null && dependents.length > 0;

  const loading = overview === null;
  const preload = overview?.shared_preload_libraries ?? [];
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      (overview?.extensions ?? []).filter(
        (e) =>
          matchesExtensionFilter(e, filter) &&
          (q === "" || e.name.toLowerCase().includes(q) || (e.comment ?? "").toLowerCase().includes(q)),
      ),
    [overview, filter, q],
  );

  const begin = (action: ExtensionAction, ext: ExtensionInfo) => {
    setStep({ action, ext });
    setSchema("");
    setCascade(false);
    setRunError(null);
    setCancelled(false);
  };
  const back = () => {
    if (busy) return;
    setStep(null);
    setRunError(null);
    setCancelled(false);
  };

  const sql = step
    ? buildExtensionSql(step.action, step.ext.name, { schema, cascade }, step.ext.default_version)
    : "";
  const canRun = step !== null && !readOnly && !busy;

  const run = () => {
    if (!step || !canRun) return;
    // 実行中は確定できない (二重送信で同じ DDL が 2 回走るのを防ぐ)。
    setBusy(true);
    setRunError(null);
    setCancelled(false);
    void onExecute(sql, step.action, step.ext.name)
      .then(async (result) => {
        if (result === "cancelled") {
          // 確認でキャンセルされた: 何も実行していないので、手順の画面に残して知らせる。
          if (mountedRef.current) setCancelled(true);
          return;
        }
        await load();
        if (mountedRef.current) setStep(null);
      })
      .catch((e) => {
        if (mountedRef.current) setRunError(String(e));
      })
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  };

  const hintKey = runError ? resolveErrorHint({ message: runError }) : null;
  const filterOptions: { value: ExtensionFilter; label: string }[] = [
    { value: "all", label: t("extensionsFilterAll") },
    { value: "installed", label: t("extensionsFilterInstalled") },
    { value: "available", label: t("extensionsFilterAvailable") },
    { value: "updatable", label: t("extensionsFilterUpdatable") },
  ];
  const actionLabel: Record<ExtensionAction, string> = {
    install: t("extensionsInstall"),
    update: t("extensionsUpdate"),
    drop: t("extensionsDrop"),
  };
  const destructive = step ? isDestructiveExtensionAction(step.action) : false;
  // 一覧から確認画面へ切り替わったとき、破壊的ならキャンセルへ初期フォーカスを移す
  // (initialFocusEl はモーダルを開いたときにしか評価されない)。
  useEffect(() => {
    if (step && isDestructiveExtensionAction(step.action)) cancelRef.current?.focus();
  }, [step]);

  return (
    <Modal
      // 破壊的な確認画面ではショートカット (Cmd/Ctrl+Enter) で実行させない。
      onSubmit={step && destructive ? undefined : run}
      submitDisabled={!canRun}
      width="720px"
      onClose={onClose}
      initialFocusEl={() => (step && destructive ? cancelRef.current : searchRef.current)}
    >
      <ModalHeader onClose={onClose} closeLabel={t("extensionsClose")}>
        {step
          ? `${t("extensionsTitle")} — ${actionLabel[step.action]}: ${step.ext.name}`
          : t("extensionsTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {readOnly && <Callout tone="warning">{t("extensionsReadOnly")}</Callout>}
        {loadError && <ErrorNote>{loadError}</ErrorNote>}

        {step === null ? (
          <>
            <chakra.div display="flex" gap="2" alignItems="center">
              <Input
                ref={searchRef}
                flex="1"
                value={query}
                placeholder={t("extensionsSearchPlaceholder")}
                aria-label={t("extensionsSearchPlaceholder")}
                onChange={(e) => setQuery(e.target.value)}
              />
              <ListboxSelect
                ariaLabel={t("extensionsFilterLabel")}
                value={filter}
                options={filterOptions}
                onChange={(v) => setFilter(v as ExtensionFilter)}
                css={{ minWidth: "10rem" }}
              />
            </chakra.div>
            {loading ? (
              <Spinner size={14} />
            ) : visible.length === 0 ? (
              <chakra.p margin={0} textStyle="caption" color="app.textMuted">
                {t("extensionsEmpty")}
              </chakra.p>
            ) : (
              <chakra.ul
                listStyleType="none"
                margin={0}
                padding={0}
                maxH="22rem"
                overflowY="auto"
                borderWidth="1px"
                borderColor="app.border"
                borderRadius="md"
              >
                {visible.map((e) => (
                  <ExtensionRow
                    key={e.name}
                    ext={e}
                    preloaded={isPreloaded(e.name, preload)}
                    readOnly={readOnly}
                    onAction={begin}
                  />
                ))}
              </chakra.ul>
            )}
          </>
        ) : (
          <>
            <chakra.p margin={0} textStyle="caption" color="app.textSecondary">
              {step.ext.comment ?? step.ext.name}
              {step.ext.installed_version
                ? ` — ${t("extensionsInstalledVersion", { version: step.ext.installed_version })}`
                : ""}
              {step.ext.default_version
                ? ` — ${t("extensionsDefaultVersion", { version: step.ext.default_version })}`
                : ""}
            </chakra.p>

            {step.action === "install" && (
              <FormSection>
                <FieldLabel htmlFor="ext-schema">{t("extensionsSchema")}</FieldLabel>
                <Input
                  id="ext-schema"
                  fontFamily="mono"
                  value={schema}
                  placeholder={t("extensionsSchemaPlaceholder")}
                  onChange={(e) => setSchema(e.target.value)}
                  disabled={readOnly}
                />
              </FormSection>
            )}

            {(step.action === "install" || step.action === "drop") && (
              <FormSection>
                <chakra.label display="flex" alignItems="center" gap="2" textStyle="body">
                  <Checkbox
                    checked={cascade}
                    disabled={readOnly}
                    onChange={(e) => setCascade(e.target.checked)}
                  />
                  {step.action === "install" ? t("extensionsCascadeInstall") : t("extensionsCascadeDrop")}
                </chakra.label>
              </FormSection>
            )}

            {step.action === "drop" && !failsWithoutCascade && (
              <Callout tone="danger">
                {cascade ? t("extensionsDropCascadeWarning") : t("extensionsDropWarning")}
              </Callout>
            )}
            {step.action === "drop" && (
              <ExtensionDependents
                key={step.ext.name}
                dependents={dependents}
                error={dependentsError}
                cascade={cascade}
              />
            )}
            {step.action === "install" &&
              needsPreload(step.ext.name) &&
              !isPreloaded(step.ext.name, preload) && (
                <Callout tone="warning">{t("extensionsPreloadNote", { name: step.ext.name })}</Callout>
              )}

            <FormSection>
              <FieldLabel as="div">{t("extensionsPreview")}</FieldLabel>
              <SqlPreview sql={`${sql};`} driver="postgres" minH="48px" wrap />
            </FormSection>

            {cancelled && !runError && <Callout tone="info">{t("extensionsNotExecuted")}</Callout>}

            {runError && (
              <ErrorNote>
                {runError}
                {hintKey && (
                  <chakra.div marginTop="1" textStyle="caption">
                    {t(hintKey)}
                  </chakra.div>
                )}
              </ErrorNote>
            )}
          </>
        )}
      </ModalBody>
      {step === null ? (
        <ModalFooter>
          <div style={{ flex: 1 }} />
          <Button type="button" variant="primary" onClick={onClose}>
            {t("extensionsClose")}
          </Button>
        </ModalFooter>
      ) : destructive ? (
        <ModalFooter>
          <Button type="button" variant="dangerOutline" disabled={!canRun} onClick={run}>
            {actionLabel[step.action]}
          </Button>
          <div style={{ flex: 1 }} />
          <Button ref={cancelRef} type="button" variant="primary" disabled={busy} onClick={back}>
            {t("extensionsCancel")}
          </Button>
        </ModalFooter>
      ) : (
        <ModalFooter>
          <div style={{ flex: 1 }} />
          <Button type="button" variant="secondary" disabled={busy} onClick={back}>
            {t("extensionsCancel")}
          </Button>
          <PressableButton type="button" variant="primary" disabled={!canRun} onClick={run}>
            {actionLabel[step.action]}
          </PressableButton>
        </ModalFooter>
      )}
    </Modal>
  );
}

function ExtensionRow({
  ext,
  preloaded,
  readOnly,
  onAction,
}: {
  ext: ExtensionInfo;
  preloaded: boolean;
  readOnly: boolean;
  onAction: (action: ExtensionAction, ext: ExtensionInfo) => void;
}) {
  const t = useT();
  const installed = ext.installed_version !== null;
  // plpgsql は削除させない (誤って消すと関数・トリガーが軒並み動かなくなる)。
  const canDrop = installed && ext.name !== "plpgsql";
  const showPreloadNote = needsPreload(ext.name) && !preloaded;
  const version = installed
    ? ext.updatable
      ? `${ext.installed_version} → ${ext.default_version}`
      : (ext.installed_version ?? "")
    : (ext.default_version ?? "");
  return (
    <chakra.li
      display="flex"
      gap="3"
      alignItems="center"
      paddingX="3"
      paddingY="2"
      borderBottomWidth="1px"
      borderColor="app.border"
      _last={{ borderBottomWidth: 0 }}
    >
      <chakra.div flex="1" minWidth={0} display="flex" flexDirection="column" gap="0.5">
        <chakra.div display="flex" gap="2" alignItems="baseline" flexWrap="wrap">
          <chakra.span fontFamily="mono" fontWeight={600}>
            {ext.name}
          </chakra.span>
          <chakra.span textStyle="caption" color={installed ? "app.textSuccess" : "app.textMuted"}>
            {version}
            {installed && ext.schema ? ` · ${ext.schema}` : ""}
          </chakra.span>
          {ext.updatable && (
            <chakra.span textStyle="caption" color="app.textWarning">
              {t("extensionsUpdatable")}
            </chakra.span>
          )}
        </chakra.div>
        {ext.comment && (
          <chakra.span textStyle="caption" color="app.textMuted">
            {ext.comment}
          </chakra.span>
        )}
        {showPreloadNote && (
          <chakra.span textStyle="caption" color="app.textWarning">
            {t("extensionsPreloadRowNote")}
          </chakra.span>
        )}
      </chakra.div>
      <chakra.div display="flex" gap="1.5" flexShrink={0}>
        {!installed && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={readOnly}
            onClick={() => onAction("install", ext)}
          >
            {t("extensionsInstall")}
          </Button>
        )}
        {ext.updatable && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={readOnly}
            onClick={() => onAction("update", ext)}
          >
            {t("extensionsUpdate")}
          </Button>
        )}
        {canDrop && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={readOnly}
            onClick={() => onAction("drop", ext)}
          >
            {t("extensionsDrop")}
          </Button>
        )}
      </chakra.div>
    </chakra.li>
  );
}
