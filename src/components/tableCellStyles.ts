import type { SystemStyleObject } from "@chakra-ui/react";

/**
 * 一覧表 (アサーション / 列プロファイルなど) のヘッダ・セルの共通スタイル。
 * 画面ごとに別定義して余白がずれるのを防ぐ。`dense` は小さな表向けの詰めた余白。
 */
export function tableThCss(dense = false): SystemStyleObject {
  return {
    position: "sticky",
    top: 0,
    zIndex: 1,
    background: "var(--bg-muted)",
    borderBottom: "1px solid var(--border)",
    padding: dense ? "var(--space-1) var(--space-2)" : "var(--space-1-5) var(--space-2-5)",
    textAlign: "left",
    textStyle: "overline",
    color: "var(--text-secondary)",
    whiteSpace: "nowrap",
  };
}

export function tableTdCss(dense = false): SystemStyleObject {
  return {
    borderBottom: "1px solid var(--border-subtle, var(--border))",
    padding: dense ? "var(--space-1) var(--space-2)" : "var(--space-2) var(--space-2-5)",
    fontSize: "var(--text-sm)",
    color: "var(--text)",
    verticalAlign: "top",
  };
}
