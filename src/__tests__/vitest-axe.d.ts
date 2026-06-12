// a11y テスト用の `toHaveNoViolations` マッチャを Vitest 4 の expect 型へ
// 拡張する。vitest-axe 同梱の型はマッチャを旧 `namespace Vi` 経由で再エクスポート
// しており Vitest 4 の `vitest` モジュール拡張と噛み合わないため、ここで自前の
// シグネチャを直接宣言する (実装は a11y.test.tsx の expect.extend が提供)。
import "vitest";

interface AxeMatchers {
  /** axe-core の結果に a11y 違反が無いことを表明する。 */
  toHaveNoViolations(): void;
}

declare module "vitest" {
  // eslint/tsc の未使用型パラメータ警告を避けつつ Vitest の Assertion を拡張する。
  interface Assertion<T = unknown> extends AxeMatchers {
    _axe?: T;
  }
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
