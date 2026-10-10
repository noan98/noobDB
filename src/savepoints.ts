// 明示トランザクションの SAVEPOINT スタック (#1418) の純ロジック。
// 名前の規則はバックエンド (`db/savepoint.rs`) と同じ: 英数字と `_`、先頭は英字か `_`、63 文字まで。

/** 現在の SAVEPOINT スタック (古い順)。末尾が最も新しい。 */
export type SavepointStack = readonly string[];

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function isValidSavepointName(name: string): boolean {
  return NAME_RE.test(name);
}

/** 次の自動名 `sp_<n>`。`counter` はトランザクション中に単調増加させる値 (名前の再利用を避ける)。 */
export function savepointName(counter: number): string {
  return `sp_${counter}`;
}

/** SAVEPOINT 作成後のスタック。同名は DB 側で上書き (新しい方が有効) になるので末尾へ移す。 */
export function pushSavepoint(stack: SavepointStack, name: string): SavepointStack {
  return [...stack.filter((n) => n !== name), name];
}

/** ROLLBACK TO 後: 指定の SAVEPOINT 自身は残り、それより新しいものを除く。未知の名前は変更なし。 */
export function afterRollbackTo(stack: SavepointStack, name: string): SavepointStack {
  const i = stack.lastIndexOf(name);
  return i < 0 ? stack : stack.slice(0, i + 1);
}

/** RELEASE 後: 指定の SAVEPOINT とそれより新しいものを除く。未知の名前は変更なし。 */
export function afterRelease(stack: SavepointStack, name: string): SavepointStack {
  const i = stack.lastIndexOf(name);
  return i < 0 ? stack : stack.slice(0, i);
}
