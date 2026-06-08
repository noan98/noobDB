import { chakra } from "@chakra-ui/react";

/**
 * 空状態 / オンボーディング向けの軽量インライン SVG イラスト (#450)。
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
