import { useEffect, useMemo, useRef, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { api, type PublicationInfo, type TableReplicaIdentity } from "../api/tauri";
import { useT } from "../i18n";
import { Callout } from "./Callout";
import { EmptyState } from "./EmptyState";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import {
  buildPublicationStatements,
  formatPublicationPreview,
  publicationActionFor,
  publicationMembership,
  replicaIdentityBlocksWrites,
  replicaIdentityFullApplies,
  replicaIdentityKind,
  type PublicationMembership,
  type PublicationPick,
} from "./publicationSql";
import { SkeletonSearchRows } from "./Skeleton";
import { SqlPreview } from "./SqlPreview";
import { Button, Checkbox, PressableButton } from "./ui";

/**
 * 表を論理レプリケーションのパブリケーションに追加 / から外すダイアログ (#2181)。
 * パブリケーションごとに「いま入っているか」を示し、変えたいものにチェックを入れると
 * `ALTER PUBLICATION ... ADD / DROP TABLE` をその場でプレビューする。確定すると呼び出し側 (App) が
 * 実行ゲートを通して 1 つのトランザクションで流す (read_only の拒否はバックエンドが行う。ここでは先回りして
 * 押せないようにする)。`FOR ALL TABLES` / `TABLES IN SCHEMA` で自動で入っているものは個別には外せない。
 */
interface Props {
  sessionId: string;
  /** PostgreSQL のスキーマ (ツリーの「データベース」)。 */
  database: string;
  table: string;
  readOnly: boolean;
  /** 実行する文と、変更するパブリケーション名 (トーストに使う)。 */
  onConfirm: (statements: string[], publications: string[]) => void | Promise<void>;
  onClose: () => void;
}

const STATE_KEYS = {
  member: "publicationStateMember",
  none: "publicationStateNone",
  all: "publicationStateAll",
  schema: "publicationStateSchema",
} as const satisfies Record<PublicationMembership, string>;

const REPLICA_KEYS = {
  default: "publicationReplicaDefault",
  defaultNoPk: "publicationReplicaDefaultNoPk",
  nothing: "publicationReplicaNothing",
  full: "publicationReplicaFull",
  index: "publicationReplicaIndex",
  partitioned: "publicationReplicaPartitioned",
} as const;

export function PublicationModal({ sessionId, database, table, readOnly, onConfirm, onClose }: Props) {
  const t = useT();
  const [publications, setPublications] = useState<PublicationInfo[] | null>(null);
  // 表の REPLICA IDENTITY (#2212)。undefined は読み込み中、null は不明 (取得失敗・表が無い)。不明なら警告しない。
  const [identity, setIdentity] = useState<TableReplicaIdentity | null | undefined>(undefined);
  const [replicaFull, setReplicaFull] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .listPublications(sessionId)
      .then((list) => {
        if (!cancelled) setPublications(list);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(t("publicationLoadError", { error: String(e) }));
        setPublications([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, t]);

  useEffect(() => {
    let cancelled = false;
    api
      .getTableReplicaIdentity(sessionId, database, table)
      .then((r) => {
        if (!cancelled) setIdentity(r);
      })
      .catch(() => {
        if (!cancelled) setIdentity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, database, table]);

  const loading = publications === null || identity === undefined;
  const rows = useMemo(
    () =>
      (publications ?? []).map((p) => {
        const membership = publicationMembership(p, database, table);
        return { name: p.name, membership, action: publicationActionFor(membership) };
      }),
    [publications, database, table],
  );
  const picks = useMemo<PublicationPick[]>(
    () =>
      rows.flatMap((r) =>
        r.action && checked.has(r.name) ? [{ publication: r.name, action: r.action }] : [],
      ),
    [rows, checked],
  );
  // 追加先のうち、入れると UPDATE / DELETE が止まるもの (#2212)。
  const riskyPubs = useMemo(
    () =>
      picks.flatMap((p) => {
        const info = p.action === "add" ? publications?.find((x) => x.name === p.publication) : undefined;
        return info && replicaIdentityBlocksWrites(info.publish, identity ?? null) ? [p.publication] : [];
      }),
    [picks, publications, identity],
  );
  const risky = riskyPubs.length > 0;
  const fullApplies = replicaIdentityFullApplies(identity ?? null);
  const useReplicaFull = risky && replicaFull && fullApplies;
  const statements = useMemo(
    () => buildPublicationStatements(database, table, picks, { replicaIdentityFull: useReplicaFull }),
    [database, table, picks, useReplicaFull],
  );
  const hasDrop = picks.some((p) => p.action === "drop");
  const ready = !loading && !readOnly && statements.length > 0;

  const toggle = (name: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const submit = () => {
    if (!ready || busy) return;
    // 実行中は確定できない (二重送信で同じ ALTER PUBLICATION が 2 回走るのを防ぐ)。
    setBusy(true);
    void Promise.resolve()
      .then(() =>
        onConfirm(
          statements,
          picks.map((p) => p.publication),
        ),
      )
      .catch(() => {})
      .finally(() => {
        if (mountedRef.current) setBusy(false);
      });
  };

  return (
    <Modal
      onSubmit={hasDrop ? undefined : submit}
      submitDisabled={!ready || busy}
      width="600px"
      onClose={onClose}
    >
      <ModalHeader onClose={onClose} closeLabel={t("publicationCancel")}>
        {t("publicationTitle")}
      </ModalHeader>
      <ModalBody display="flex" flexDirection="column" gap="4">
        {readOnly && <Callout tone="warning">{t("publicationReadOnly")}</Callout>}
        {loadError && <ErrorNote>{loadError}</ErrorNote>}

        <FormSection>
          <FieldLabel as="div">{t("publicationTable")}</FieldLabel>
          <chakra.code fontFamily="mono" textStyle="body">
            {database}.{table}
          </chakra.code>
        </FormSection>

        {identity && (
          <chakra.p margin={0} textStyle="caption" color="app.textMuted">
            {t("publicationReplicaIdentityLabel")}: {t(REPLICA_KEYS[replicaIdentityKind(identity)])}
          </chakra.p>
        )}

        <chakra.p margin={0} textStyle="caption" color="app.textMuted">
          {t("publicationHint")}
        </chakra.p>

        {loading ? (
          <chakra.div
            role="status"
            aria-label={t("spinnerLoadingAria")}
            borderWidth="1px"
            borderColor="app.border"
            borderRadius="md"
            paddingY="1"
          >
            <SkeletonSearchRows rows={3} />
          </chakra.div>
        ) : rows.length === 0 ? (
          !loadError && (
            <EmptyState
              compact
              icon="broadcast"
              title={t("publicationNoneTitle")}
              description={t("publicationNone")}
            />
          )
        ) : (
          <FormSection as="div" role="group" aria-label={t("objGroupPublications")}>
            {rows.map((r) => (
              <chakra.label
                key={r.name}
                display="flex"
                alignItems="center"
                gap="2"
                textStyle="body"
                opacity={r.action === null ? 0.6 : 1}
              >
                <Checkbox
                  checked={checked.has(r.name)}
                  disabled={readOnly || r.action === null}
                  onChange={(e) => toggle(r.name, e.target.checked)}
                />
                <chakra.span fontFamily="mono">{r.name}</chakra.span>
                <chakra.span textStyle="caption" color="app.textMuted">
                  {t(STATE_KEYS[r.membership])}
                </chakra.span>
                {r.action && (
                  <chakra.span textStyle="caption" color="app.textSecondary" marginLeft="auto">
                    {r.action === "add" ? t("publicationActionAdd") : t("publicationActionDrop")}
                  </chakra.span>
                )}
              </chakra.label>
            ))}
          </FormSection>
        )}

        {risky && (
          <Callout
            tone={useReplicaFull ? "info" : "warning"}
            title={t(useReplicaFull ? "publicationReplicaFullTitle" : "publicationReplicaWarnTitle", {
              names: riskyPubs.join(", "),
            })}
          >
            <chakra.p margin={0}>{t("publicationReplicaWarnBody")}</chakra.p>
            <chakra.ul margin={0} paddingLeft="5" marginTop="1">
              <li>{t("publicationReplicaFixPk")}</li>
              <li>{t(fullApplies ? "publicationReplicaFixFull" : "publicationReplicaFixFullPartition")}</li>
              <li>{t("publicationReplicaFixInsertOnly")}</li>
            </chakra.ul>
            <chakra.label display="flex" alignItems="center" gap="2" marginTop="2" textStyle="body">
              <Checkbox
                checked={replicaFull && fullApplies}
                disabled={!fullApplies}
                onChange={(e) => setReplicaFull(e.target.checked)}
              />
              <span>{t("publicationReplicaFullOption")}</span>
            </chakra.label>
            {!fullApplies && (
              <chakra.p margin={0} marginTop="1" textStyle="caption">
                {t("publicationReplicaPartitionNote")}
              </chakra.p>
            )}
            {useReplicaFull && (
              <chakra.p margin={0} marginTop="1" textStyle="caption">
                {t("publicationReplicaFullWalNote")}
              </chakra.p>
            )}
          </Callout>
        )}
        {hasDrop && <Callout tone="warning">{t("publicationDropWarn")}</Callout>}
        {statements.length > 0 && <Callout tone="info">{t("publicationRefreshNote")}</Callout>}

        <FormSection>
          <FieldLabel as="div">{t("publicationPreview")}</FieldLabel>
          <SqlPreview
            sql={formatPublicationPreview(statements)}
            driver="postgres"
            empty={t("publicationPreviewEmpty")}
            minH="48px"
            wrap
          />
        </FormSection>
      </ModalBody>
      <ModalFooter>
        {hasDrop ? (
          // 表を外す操作を含むときは破壊的パターン: 実行 (dangerOutline) → spacer → キャンセル (primary)。操作の途中で切り替わるので、フォーカスは動かさない。
          <>
            <Button type="button" variant="dangerOutline" disabled={!ready || busy} onClick={submit}>
              {t("publicationConfirm")}
            </Button>
            <div style={{ flex: 1 }} />
            <Button type="button" variant="primary" onClick={onClose}>
              {t("publicationCancel")}
            </Button>
          </>
        ) : (
          <>
            <div style={{ flex: 1 }} />
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("publicationCancel")}
            </Button>
            <PressableButton type="button" variant="primary" disabled={!ready || busy} onClick={submit}>
              {t("publicationConfirm")}
            </PressableButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
}
