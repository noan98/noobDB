import { useEffect, useMemo, useState } from "react";
import { chakra } from "@chakra-ui/react";
import { AnimatePresence, motion } from "motion/react";
import { save } from "@tauri-apps/plugin-dialog";
import { dirname, downloadDir, join } from "@tauri-apps/api/path";
import { api, type ConnectionProfile, type SyncPlan } from "../api/tauri";
import { useT } from "../i18n";
import { transitions, variants } from "../motion";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "./Modal";
import { Button, Input, Select } from "./ui";
import { LoadingButton } from "./LoadingButton";
import { ErrorNote, FieldLabel, FormSection } from "./modalForm";
import { useToast } from "./Toast";
import { coerceDriver } from "./SchemaCompareView";
import {
  buildMigrationFile,
  buildMigrationHeader,
  defaultMigrationName,
  migrationFileNames,
  migrationVersion,
  sanitizeMigrationName,
  MIGRATION_FORMATS,
  type MigrationEndpointMeta,
  type MigrationFormat,
} from "./migrationExport";

interface Props {
  /** `SchemaCompareView` が既に生成した schema 同期プラン (up 方向)。 */
  plan: SyncPlan;
  allowDestructive: boolean;
  sourceSessionId: string;
  sourceDatabase: string;
  sourceProfile: ConnectionProfile;
  targetSessionId: string;
  targetDatabase: string;
  targetProfile: ConnectionProfile;
  onClose: () => void;
}

type DownState =
  | { kind: "loading" }
  | { kind: "ready"; plan: SyncPlan }
  | { kind: "error"; message: string };

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "done"; upPath: string; downPath: string }
  | { kind: "error"; message: string };

function endpointMeta(profile: ConnectionProfile, database: string): MigrationEndpointMeta {
  const driver = coerceDriver(profile.driver);
  return {
    profileName: profile.name,
    driver,
    database,
    host: driver === "sqlite" ? null : profile.host,
    port: driver === "sqlite" ? null : profile.port,
    filePath: driver === "sqlite" ? profile.file_path : null,
  };
}

/**
 * スキーマ比較結果を Flyway / golang-migrate / sqlx / 汎用形式の up/down
 * マイグレーションファイルとして書き出すモーダル (#744)。
 *
 * - **up**: 呼び出し側 (`SchemaCompareView`) が既に生成した `plan` (`props`)
 *   をそのまま SQL 化する — 新規の生成ロジックはない。
 * - **down**: ソース/ターゲットを入れ替えて `compare_schema` →
 *   `generate_sync_sql` を再実行した逆方向プランをファイル化する。マウント時
 *   (と `allowDestructive` 変化時) に取得し、取得中は保存ボタンを無効化する。
 * - DB へは一切書き込まない (比較・SQL 生成のみ) ため、両側が読み取り専用
 *   セッションでも利用できる。
 */
export function MigrationExportModal({
  plan,
  allowDestructive,
  sourceSessionId,
  sourceDatabase,
  sourceProfile,
  targetSessionId,
  targetDatabase,
  targetProfile,
  onClose,
}: Props) {
  const t = useT();
  const toast = useToast();

  const [format, setFormat] = useState<MigrationFormat>("flyway");
  const [name, setName] = useState(() => defaultMigrationName(sourceDatabase, targetDatabase));
  // 生成日時とバージョン番号はモーダルを開いた時点で 1 回だけ確定し、up/down の
  // 両ファイルで一致させる (バージョン番号はタイムスタンプ採番。#744)。
  const [generatedAt] = useState(() => new Date());
  const version = useMemo(() => migrationVersion(generatedAt), [generatedAt]);

  const [downState, setDownState] = useState<DownState>({ kind: "loading" });
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    setDownState({ kind: "loading" });
    (async () => {
      // ソース/ターゲットを入れ替えて再実行した逆方向プラン。既存の
      // compare_schema / generate_sync_sql をそのまま再利用するだけで、
      // 新規の逆変換ロジックは書かない。
      const diff = await api.compareSchema({
        sourceSessionId: targetSessionId,
        sourceDatabase: targetDatabase,
        targetSessionId: sourceSessionId,
        targetDatabase: sourceDatabase,
      });
      if (cancelled) return;
      const downPlan = await api.generateSyncSql(diff, allowDestructive);
      if (cancelled) return;
      setDownState({ kind: "ready", plan: downPlan });
    })().catch((e) => {
      if (!cancelled) setDownState({ kind: "error", message: String(e) });
    });
    return () => {
      cancelled = true;
    };
  }, [sourceSessionId, sourceDatabase, targetSessionId, targetDatabase, allowDestructive]);

  const sanitizedName = useMemo(() => sanitizeMigrationName(name), [name]);
  const fileNames = useMemo(
    () => migrationFileNames(format, version, sanitizedName),
    [format, version, sanitizedName],
  );

  const sourceMeta = useMemo(
    () => endpointMeta(sourceProfile, sourceDatabase),
    [sourceProfile, sourceDatabase],
  );
  const targetMeta = useMemo(
    () => endpointMeta(targetProfile, targetDatabase),
    [targetProfile, targetDatabase],
  );

  const isSaving = status.kind === "saving";
  const downReady = downState.kind === "ready";

  const handleSave = async () => {
    if (downState.kind !== "ready") return;
    setStatus({ kind: "saving" });
    try {
      const headerUp = buildMigrationHeader({
        generatedAt,
        format,
        direction: "up",
        source: sourceMeta,
        target: targetMeta,
      });
      const headerDown = buildMigrationHeader({
        generatedAt,
        format,
        direction: "down",
        source: sourceMeta,
        target: targetMeta,
      });
      const contentUp = buildMigrationFile(headerUp, plan);
      const contentDown = buildMigrationFile(headerDown, downState.plan);

      let defaultPath = fileNames.up;
      try {
        defaultPath = await join(await downloadDir(), fileNames.up);
      } catch {
        // ダウンロードフォルダが解決できない環境ではファイル名のみで開く。
      }
      const picked = await save({
        defaultPath,
        title: t("schemaCompareMigrationSaveTitle"),
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (typeof picked !== "string" || !picked) {
        setStatus({ kind: "idle" });
        return;
      }
      // 選んだ場所のフォルダへ、規則どおりの up/down ファイル名で対にして保存する
      // (up 側のファイル名を保存ダイアログで変更しても、down はペアの命名規則を
      // 保つため常にこちらの計算結果を使う)。
      const dir = await dirname(picked);
      const upPath = await join(dir, fileNames.up);
      const downPath = await join(dir, fileNames.down);

      await api.writeBinaryFile(upPath, new TextEncoder().encode(contentUp));
      await api.writeBinaryFile(downPath, new TextEncoder().encode(contentDown));

      setStatus({ kind: "done", upPath, downPath });
      toast.success(t("schemaCompareMigrationSaved", { up: upPath, down: downPath }));
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
      toast.error(t("schemaCompareMigrationError", { error: String(e) }));
    }
  };

  return (
    <Modal width="560px" onClose={onClose} closeOnInteractOutside={!isSaving} closeOnEscape={!isSaving}>
      <ModalHeader onClose={onClose} closeLabel={t("schemaCompareClose")} closeDisabled={isSaving}>
        {t("schemaCompareMigrationTitle")}
      </ModalHeader>

      <ModalBody display="flex" flexDirection="column" gap="4">
        <chakra.div fontSize="sm" color="app.textMuted" lineHeight={1.5}>
          {t("schemaCompareMigrationDesc")}
        </chakra.div>

        <FormSection>
          <FieldLabel htmlFor="migration-export-format">
            {t("schemaCompareMigrationFormat")}
          </FieldLabel>
          <Select
            id="migration-export-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as MigrationFormat)}
            disabled={isSaving}
          >
            {MIGRATION_FORMATS.map((f) => (
              <option key={f} value={f}>
                {formatLabel(f, t)}
              </option>
            ))}
          </Select>
        </FormSection>

        <FormSection>
          <FieldLabel htmlFor="migration-export-name">{t("schemaCompareMigrationName")}</FieldLabel>
          <Input
            id="migration-export-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isSaving}
          />
          <chakra.div fontSize="xs" color="app.textMuted">
            {t("schemaCompareMigrationNameHint", { name: sanitizedName })}
          </chakra.div>
        </FormSection>

        <FormSection>
          <FieldLabel as="div">{t("schemaCompareMigrationFiles")}</FieldLabel>
          <chakra.pre
            m={0}
            p="2.5"
            bg="app.bgInput"
            border="1px solid"
            borderColor="app.border"
            borderRadius="md"
            fontFamily="mono"
            fontSize="xs"
            color="app.text"
            whiteSpace="pre-wrap"
            wordBreak="break-word"
          >
            {`up:   ${fileNames.up}\ndown: ${fileNames.down}`}
          </chakra.pre>
        </FormSection>

        {/* down マイグレーションの取得は非同期 (loading → ready/error) なので、
            結果表示の差し替えをクロスフェードする (#1025)。この区間はどれも
            フォーカス可能な入力を持たないため、退出アニメ中のフォーカス喪失は
            起きない。 */}
        <AnimatePresence mode="wait" initial={false}>
          {downState.kind === "loading" && (
            <motion.div
              key="migration-down-loading"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <chakra.div fontSize="sm" color="app.textSecondary">
                {t("schemaCompareMigrationLoadingDown")}
              </chakra.div>
            </motion.div>
          )}
          {downState.kind === "error" && (
            <motion.div
              key="migration-down-error"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <ErrorNote>{t("schemaCompareMigrationDownError", { error: downState.message })}</ErrorNote>
            </motion.div>
          )}
          {downState.kind === "ready" && (
            <motion.div
              key="migration-down-ready"
              initial={variants.fade.initial}
              animate={variants.fade.animate}
              exit={variants.fade.exit}
              transition={transitions.crossfade}
            >
              <chakra.div fontSize="xs" color="app.textMuted">
                {t("schemaCompareMigrationSummary", {
                  upCount: plan.statements.length,
                  downCount: downState.plan.statements.length,
                  warnings: plan.warnings.length + downState.plan.warnings.length,
                })}
              </chakra.div>
            </motion.div>
          )}
        </AnimatePresence>

        {status.kind === "error" && (
          <ErrorNote>{t("schemaCompareMigrationError", { error: status.message })}</ErrorNote>
        )}
        {status.kind === "done" && (
          <chakra.div fontSize="sm" color="app.textSuccess">
            {t("schemaCompareMigrationSaved", { up: status.upPath, down: status.downPath })}
          </chakra.div>
        )}
      </ModalBody>

      <ModalFooter>
        <div style={{ flex: 1 }} />
        <Button type="button" variant="secondary" onClick={onClose} disabled={isSaving}>
          {t("schemaCompareMigrationCancel")}
        </Button>
        <LoadingButton
          pressable
          type="button"
          variant="primary"
          loading={isSaving}
          onClick={handleSave}
          disabled={isSaving || !downReady}
        >
          {isSaving ? t("schemaCompareMigrationSaving") : t("schemaCompareMigrationSave")}
        </LoadingButton>
      </ModalFooter>
    </Modal>
  );
}

function formatLabel(format: MigrationFormat, t: ReturnType<typeof useT>): string {
  switch (format) {
    case "flyway":
      return t("schemaCompareMigrationFormatFlyway");
    case "golang-migrate":
      return t("schemaCompareMigrationFormatGolangMigrate");
    case "sqlx":
      return t("schemaCompareMigrationFormatSqlx");
    case "generic":
      return t("schemaCompareMigrationFormatGeneric");
  }
}
