import { chakra } from "@chakra-ui/react";
import type { CSSProperties } from "react";
import { t } from "../i18n";

/**
 * 設定「表示」セクションのライブ・アピアランス・プレビュー (#1581)。
 *
 * ツールバー 1 個 + サイドバー行 + 結果の行 (選択中を含む) + SQL トークン列からなる
 * ミニ・アプリクロームのモック。色・余白・文字サイズはすべて `app.*` / `syntax.*` トークンと
 * `--density-*` 変数を参照するだけなので、テーマ / アクセント / 密度 / フォント拡大 /
 * シンタックス配色の変更はそのまま映る (値の二重管理なし)。
 * `previewVars` を渡すと、その CSS 変数だけをモックの範囲で上書きして「選ぶ前」の
 * 見た目を出す (`appearancePreviewVars`)。色の切替は短い transition でクロスフェードする
 * (reduced-motion では App.css のグローバル規則が無効化する)。
 */

const fade = {
  transitionProperty: "background-color, color, border-color",
  transitionDuration: "var(--dur-med)",
  transitionTimingFunction: "var(--ease-out)",
};

const Frame = chakra("div", {
  base: {
    borderWidth: "1px",
    borderColor: "app.borderStrong",
    borderRadius: "md",
    bg: "app.bg",
    color: "app.text",
    overflow: "hidden",
    fontSize: "sm",
    ...fade,
  },
});

const Toolbar = chakra("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "2",
    px: "2",
    py: "1.5",
    bg: "app.toolbar",
    borderBottomWidth: "1px",
    borderColor: "app.border",
    ...fade,
  },
});

const RunButton = chakra("span", {
  base: {
    px: "2",
    py: "0.5",
    borderRadius: "sm",
    bg: "app.accent",
    color: "app.accentText",
    fontSize: "xs",
    fontWeight: 600,
    ...fade,
  },
});

const Body = chakra("div", { base: { display: "flex" } });

const Sidebar = chakra("div", {
  base: {
    width: "28%",
    display: "flex",
    flexDirection: "column",
    borderRightWidth: "1px",
    borderColor: "app.border",
    bg: "app.surface",
    py: "1",
    ...fade,
  },
});

const SideRow = chakra("div", {
  base: {
    px: "2",
    fontSize: "xs",
    color: "app.textSecondary",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    ...fade,
  },
  variants: {
    selected: {
      true: { bg: "app.accentHighlight", color: "app.text", fontWeight: 600 },
    },
  },
});

const Main = chakra("div", { base: { flex: 1, minWidth: 0 } });

const Sql = chakra("div", {
  base: {
    px: "2",
    py: "1.5",
    fontFamily: "mono",
    fontSize: "xs",
    borderBottomWidth: "1px",
    borderColor: "app.border",
    whiteSpace: "nowrap",
    overflow: "hidden",
    ...fade,
  },
});

const GridRow = chakra("div", {
  base: {
    display: "flex",
    gap: "3",
    fontSize: "xs",
    ...fade,
  },
  variants: {
    kind: {
      head: { bg: "app.header", color: "app.textMuted", fontWeight: 600 },
      body: { color: "app.text" },
      selected: { bg: "app.accentHighlight", color: "app.text" },
    },
  },
});

const Cell = chakra("span", {
  base: { flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
});

// 行の縦余白・横余白は表示密度 (--density-cell-*) をそのまま使う。
const rowPad: CSSProperties = {
  paddingBlock: "var(--density-cell-py)",
  paddingInline: "var(--density-cell-px)",
};

export function AppearancePreview({ previewVars }: { previewVars?: Record<string, string> }) {
  return (
    <Frame
      role="img"
      aria-label={t("settingsAppearancePreviewLabel")}
      data-testid="appearance-preview"
      style={previewVars as CSSProperties | undefined}
    >
      <Toolbar>
        <RunButton>{t("settingsAppearancePreviewRun")}</RunButton>
        <chakra.span textStyle="caption">{t("settingsAppearancePreviewConn")}</chakra.span>
      </Toolbar>
      <Body>
        <Sidebar>
          <SideRow style={{ paddingBlock: "var(--density-tree-py)" }}>users</SideRow>
          <SideRow selected style={{ paddingBlock: "var(--density-tree-py)" }}>
            orders
          </SideRow>
          <SideRow style={{ paddingBlock: "var(--density-tree-py)" }}>items</SideRow>
        </Sidebar>
        <Main>
          <Sql>
            <chakra.span color="app.syntax.keyword">SELECT</chakra.span> id,{" "}
            <chakra.span color="app.syntax.function">COUNT</chakra.span>(*){" "}
            <chakra.span color="app.syntax.keyword">FROM</chakra.span> orders{" "}
            <chakra.span color="app.syntax.keyword">WHERE</chakra.span> total{" "}
            <chakra.span color="app.syntax.operator">&gt;</chakra.span>{" "}
            <chakra.span color="app.syntax.number">100</chakra.span>{" "}
            <chakra.span color="app.syntax.string">&apos;paid&apos;</chakra.span>{" "}
            <chakra.span color="app.syntax.comment">-- sample</chakra.span>
          </Sql>
          <GridRow kind="head" style={rowPad}>
            <Cell>id</Cell>
            <Cell>status</Cell>
            <Cell>total</Cell>
          </GridRow>
          <GridRow kind="body" style={rowPad}>
            <Cell>1</Cell>
            <Cell>paid</Cell>
            <Cell>120</Cell>
          </GridRow>
          <GridRow kind="selected" style={rowPad}>
            <Cell>2</Cell>
            <Cell>pending</Cell>
            <Cell>80</Cell>
          </GridRow>
        </Main>
      </Body>
    </Frame>
  );
}
