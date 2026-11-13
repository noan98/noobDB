import { chakra } from "@chakra-ui/react";
import { Icon } from "./Icon";

/**
 * バージョン番号のピル (#1864 / #2297)。`WhatsNewModal` (適用後) と `UpdateAvailableModal` (適用前) で
 * 同じ見た目にするための共通部品。`current` は現行版 (控えめな面)、既定は新版 (info のベタ塗り)。
 * ベタ塗り + `app.onSolid` は themeContrast.test が全テーマで AA を保証する組み合わせ。
 */
export function VersionPill({
  version,
  current = false,
  testId,
}: {
  /** 表示用に整形済みの版 (先頭の `v` は付けない)。 */
  version: string;
  /** true なら現行版 (控えめな見た目)。 */
  current?: boolean;
  testId?: string;
}) {
  return (
    <chakra.span
      data-testid={testId}
      textStyle="numeric"
      display="inline-flex"
      alignItems="center"
      gap="1"
      py="0.5"
      px="2"
      borderRadius="pill"
      fontSize="sm"
      fontWeight="semibold"
      bg={current ? "app.surfaceMuted" : "app.info.solid"}
      color={current ? "app.textSecondary" : "app.onSolid"}
    >
      {!current && <Icon name="sparkles" />}v{version}
    </chakra.span>
  );
}
