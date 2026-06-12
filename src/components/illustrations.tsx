import { chakra } from "@chakra-ui/react";

/**
 * 空状態 / オンボーディング向けの軽量インライン SVG イラスト。
 *
 * 依存ライブラリは増やさず、すべてここに直接 SVG を持つ。線は `currentColor`
 * (= 周囲のテキスト色) を継承し、強調部のみワークスペースアクセント
 * (`var(--ws-accent)` / `var(--accent)`) を使うため、ライト/ダーク・アクセント色に
 * 自動追従する。装飾なので `aria-hidden`。Motion はラッパー (EmptyState) 側で付く。
 */

const Svg = chakra("svg");

interface IllustrationProps {
  size?: number;
}

/** 接続未作成 (オンボーディング): サーバスタック + アクセントの「+」スパーク。 */
export function WelcomeIllustration({ size = 96 }: IllustrationProps) {
  return (
    <Svg
      width={`${size}px`}
      height={`${(size * 3) / 4}px`}
      viewBox="0 0 128 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      color="app.textSecondary"
      aria-hidden="true"
      role="img"
    >
      <rect x="30" y="20" width="68" height="20" rx="4" opacity="0.5" />
      <rect x="30" y="46" width="68" height="20" rx="4" opacity="0.75" />
      <rect x="30" y="72" width="68" height="14" rx="4" opacity="0.4" />
      <circle cx="42" cy="30" r="2.5" fill="currentColor" stroke="none" opacity="0.6" />
      <circle cx="42" cy="56" r="2.5" fill="currentColor" stroke="none" opacity="0.8" />
      {/* アクセントの「+」スパーク (新規作成の合図) */}
      <g stroke="var(--ws-accent, var(--accent))" strokeWidth={2.5}>
        <circle cx="98" cy="22" r="11" fill="color-mix(in srgb, var(--ws-accent, var(--accent)) 16%, transparent)" />
        <path d="M98 17v10M93 22h10" />
      </g>
    </Svg>
  );
}

/** 未接続: 抜けたプラグ (接続を選ぶ誘導)。 */
export function DisconnectedIllustration({ size = 96 }: IllustrationProps) {
  return (
    <Svg
      width={`${size}px`}
      height={`${(size * 3) / 4}px`}
      viewBox="0 0 128 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      color="app.textSecondary"
      aria-hidden="true"
      role="img"
    >
      {/* 左のソケット */}
      <path d="M20 48h22" opacity="0.6" />
      <path d="M30 38v8M30 50v8" opacity="0.6" />
      <rect x="42" y="36" width="16" height="24" rx="4" />
      {/* 右のプラグ (離れている = 未接続) */}
      <rect x="74" y="36" width="16" height="24" rx="4" />
      <path d="M90 48h18" opacity="0.6" />
      <path d="M82 30v6M82 60v6" />
      {/* 切断のスパーク */}
      <path
        d="M60 40l8 8-8 8"
        stroke="var(--ws-accent, var(--accent))"
        strokeWidth={2.5}
        opacity="0.9"
      />
    </Svg>
  );
}

/** 結果なし: 空のグリッド + 虫眼鏡。 */
export function NoResultsIllustration({ size = 84 }: IllustrationProps) {
  return (
    <Svg
      width={`${size}px`}
      height={`${(size * 3) / 4}px`}
      viewBox="0 0 128 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      color="app.textSecondary"
      aria-hidden="true"
      role="img"
    >
      <rect x="24" y="20" width="64" height="52" rx="4" opacity="0.6" />
      <path d="M24 34h64M46 20v52M46 34" opacity="0.45" />
      <path d="M24 48h64M24 60h64" opacity="0.3" />
      {/* 虫眼鏡 (アクセント) */}
      <g stroke="var(--ws-accent, var(--accent))" strokeWidth={2.5}>
        <circle cx="84" cy="64" r="14" fill="color-mix(in srgb, var(--ws-accent, var(--accent)) 12%, transparent)" />
        <path d="M94 74l10 10" />
      </g>
    </Svg>
  );
}

/** 接続失敗: 断線したサーバ + 赤い ✕。 */
export function ConnectionFailedIllustration({ size = 96 }: IllustrationProps) {
  return (
    <Svg
      width={`${size}px`}
      height={`${(size * 3) / 4}px`}
      viewBox="0 0 128 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      color="app.textSecondary"
      aria-hidden="true"
      role="img"
    >
      {/* サーバスタック */}
      <rect x="20" y="18" width="60" height="18" rx="4" opacity="0.5" />
      <rect x="20" y="42" width="60" height="18" rx="4" opacity="0.7" />
      <circle cx="30" cy="27" r="2.5" fill="currentColor" stroke="none" opacity="0.5" />
      <circle cx="30" cy="51" r="2.5" fill="currentColor" stroke="none" opacity="0.7" />
      {/* 断線ケーブル */}
      <path d="M80 51h12" opacity="0.4" strokeDasharray="4 3" />
      {/* ✕ マーク (エラー色) */}
      <g stroke="var(--chakra-colors-app-textError, #e53e3e)" strokeWidth={2.5}>
        <circle
          cx="104"
          cy="27"
          r="14"
          fill="color-mix(in srgb, var(--chakra-colors-app-textError, #e53e3e) 12%, transparent)"
          stroke="var(--chakra-colors-app-textError, #e53e3e)"
        />
        <path d="M97 20l14 14M111 20L97 34" />
      </g>
    </Svg>
  );
}

/** タイムアウト: 砂時計 + アクセントの時計。 */
export function TimeoutIllustration({ size = 96 }: IllustrationProps) {
  return (
    <Svg
      width={`${size}px`}
      height={`${(size * 3) / 4}px`}
      viewBox="0 0 128 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      color="app.textSecondary"
      aria-hidden="true"
      role="img"
    >
      {/* 砂時計外枠 */}
      <path
        d="M42 14h44M42 82h44M48 14C48 14 38 32 48 48C38 64 48 82 48 82H80C80 82 90 64 80 48C90 32 80 14 80 14Z"
        opacity="0.6"
      />
      {/* 上の砂 (残り少ない) */}
      <path d="M54 22h20L68 36h-8z" fill="currentColor" stroke="none" opacity="0.3" />
      {/* 下の砂 (溜まっている) */}
      <path d="M50 72h28L72 58H56z" fill="currentColor" stroke="none" opacity="0.5" />
      {/* くびれ部分の砂粒 */}
      <circle cx="64" cy="48" r="2" fill="currentColor" stroke="none" opacity="0.7" />
      {/* アクセントの時計アイコン */}
      <g stroke="var(--ws-accent, var(--accent))" strokeWidth={2.5}>
        <circle
          cx="100"
          cy="22"
          r="14"
          fill="color-mix(in srgb, var(--ws-accent, var(--accent)) 14%, transparent)"
        />
        <path d="M100 14v8l5 4" />
      </g>
    </Svg>
  );
}

/** 権限不足: 錠前 + 盾。 */
export function PermissionDeniedIllustration({ size = 96 }: IllustrationProps) {
  return (
    <Svg
      width={`${size}px`}
      height={`${(size * 3) / 4}px`}
      viewBox="0 0 128 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      color="app.textSecondary"
      aria-hidden="true"
      role="img"
    >
      {/* 錠前ボディ */}
      <rect x="38" y="46" width="36" height="30" rx="4" opacity="0.7" />
      {/* 錠前アーチ */}
      <path d="M46 46V36a10 10 0 0 1 20 0v10" opacity="0.6" />
      {/* キーホール */}
      <circle cx="56" cy="60" r="4" fill="currentColor" stroke="none" opacity="0.5" />
      <rect x="54" y="60" width="4" height="8" rx="1" fill="currentColor" stroke="none" opacity="0.5" />
      {/* アクセントの盾 */}
      <g stroke="var(--ws-accent, var(--accent))" strokeWidth={2.5}>
        <path
          d="M96 14l16 6v14c0 8-7 15-16 18C87 49 80 42 80 34V20z"
          fill="color-mix(in srgb, var(--ws-accent, var(--accent)) 14%, transparent)"
        />
        <path d="M90 32l5 5 8-8" />
      </g>
    </Svg>
  );
}

/** 本番接続警告: サーバ + 警告三角。 */
export function ProductionWarningIllustration({ size = 96 }: IllustrationProps) {
  return (
    <Svg
      width={`${size}px`}
      height={`${(size * 3) / 4}px`}
      viewBox="0 0 128 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      color="app.textSecondary"
      aria-hidden="true"
      role="img"
    >
      {/* サーバスタック */}
      <rect x="18" y="20" width="60" height="18" rx="4" opacity="0.5" />
      <rect x="18" y="44" width="60" height="18" rx="4" opacity="0.75" />
      <rect x="18" y="68" width="60" height="14" rx="4" opacity="0.4" />
      <circle cx="28" cy="29" r="2.5" fill="currentColor" stroke="none" opacity="0.5" />
      <circle cx="28" cy="53" r="2.5" fill="currentColor" stroke="none" opacity="0.75" />
      {/* 警告三角 (アクセント: amber 系はトークンに乗せず ws-accent で統一) */}
      <g stroke="var(--ws-accent, var(--accent))" strokeWidth={2.5}>
        <path
          d="M96 12l24 42H72z"
          fill="color-mix(in srgb, var(--ws-accent, var(--accent)) 16%, transparent)"
        />
        <path d="M96 26v14M96 46v4" />
      </g>
    </Svg>
  );
}

/** スキーマ読み込み失敗: 壊れたテーブルグリッド + 警告アイコン。 */
export function SchemaLoadFailedIllustration({ size = 96 }: IllustrationProps) {
  return (
    <Svg
      width={`${size}px`}
      height={`${(size * 3) / 4}px`}
      viewBox="0 0 128 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      color="app.textSecondary"
      aria-hidden="true"
      role="img"
    >
      {/* テーブルグリッド (左上半分は正常) */}
      <rect x="14" y="16" width="70" height="56" rx="4" opacity="0.55" />
      <path d="M14 32h70M36 16v56" opacity="0.4" />
      <path d="M14 48h70M14 62h52" opacity="0.3" />
      {/* 右下が欠けた破断線 */}
      <path
        d="M66 62l8 10M74 62l8 10"
        stroke="currentColor"
        opacity="0.25"
        strokeDasharray="3 3"
      />
      {/* 警告アイコン (アクセント) */}
      <g stroke="var(--ws-accent, var(--accent))" strokeWidth={2.5}>
        <circle
          cx="103"
          cy="65"
          r="16"
          fill="color-mix(in srgb, var(--ws-accent, var(--accent)) 14%, transparent)"
        />
        <path d="M103 55v12M103 73v3" />
      </g>
    </Svg>
  );
}
