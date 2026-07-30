import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import {
  errorIllustration,
  ConnectionFailedIllustration,
  TimeoutIllustration,
  PermissionDeniedIllustration,
  SchemaLoadFailedIllustration,
} from "../components/illustrations";

/**
 * errorIllustration (#848) のユニットテスト。
 *
 * `ResultGrid` の「エラー種別 → イラスト」対応から切り出した共有ヘルパーで、
 * `errorHints.illustrationForError` の分類結果 (`illustrationForError.test.ts` で
 * 別途検証済み) を実際のイラストコンポーネントへ正しくマッピングすることだけを
 * ここで確認する。返り値は React 要素なので `.type` で使われたコンポーネント
 * 関数そのものを検証する (レンダリングまでは行わない、純粋なマッピングのテスト)。
 * 戻り値の型は `ReactNode | undefined` (文字列等も理論上は許容) だが、実装は
 * 常に単一の要素かつ `undefined` しか返さないため、テスト側でのみ絞り込む。
 */
function asElement(node: unknown): ReactElement<{ size: number }> | undefined {
  return node as ReactElement<{ size: number }> | undefined;
}

describe("errorIllustration", () => {
  it("接続失敗系のエラーには ConnectionFailedIllustration を割り当てる", () => {
    const el = asElement(errorIllustration("Connection refused (os error 111)"));
    expect(el?.type).toBe(ConnectionFailedIllustration);
  });

  it("タイムアウト系のエラーには TimeoutIllustration を割り当てる", () => {
    const el = asElement(errorIllustration("Query timed out after 30s"));
    expect(el?.type).toBe(TimeoutIllustration);
  });

  it("権限不足/認証失敗のエラーには PermissionDeniedIllustration を割り当てる", () => {
    const el = asElement(errorIllustration("Access denied for user 'root'@'localhost'"));
    expect(el?.type).toBe(PermissionDeniedIllustration);
  });

  it("スキーマ系のエラーには SchemaLoadFailedIllustration を割り当てる", () => {
    const el = asElement(errorIllustration("Table 'mydb.users' doesn't exist"));
    expect(el?.type).toBe(SchemaLoadFailedIllustration);
  });

  it("その他 (構文エラー等) のエラーには専用イラストが無く undefined を返す", () => {
    const el = errorIllustration("You have an error in your SQL syntax");
    expect(el).toBeUndefined();
  });

  it("size 引数が渡らない場合は既定の 72 を使う", () => {
    const el = asElement(errorIllustration("Connection refused"));
    expect(el?.props).toMatchObject({ size: 72 });
  });

  it("size 引数を渡すとそのサイズがイラストへ伝わる", () => {
    const el = asElement(errorIllustration("Connection refused", 40));
    expect(el?.props).toMatchObject({ size: 40 });
  });
});
