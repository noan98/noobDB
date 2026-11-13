/**
 * 画面が所有する接続セッションの共有プール (#2300)。
 *
 * 同じキー (プロファイル ID) への並行要求は、接続中の Promise を共有して
 * 接続を 1 本にまとめる。失敗した接続は取り除き、次の要求で再接続する。
 * `release()` 以降に完了した接続は、その場で `disconnect` する
 * (接続中に画面が閉じられても、完了したセッションを取り残さない)。
 */
export interface SessionPool {
  /** キーのセッションを返す。接続中ならその Promise を共有し、無ければ `connect` を呼ぶ。 */
  acquire(key: string, connect: () => Promise<string>): Promise<string>;
  /** 全セッションを切断し、接続中のものは完了次第切断する。再度 `acquire` すれば新しく接続できる。 */
  release(): void;
}

export function createSessionPool(disconnect: (sessionId: string) => Promise<unknown>): SessionPool {
  let generation = 0;
  const sessions = new Map<string, Promise<string>>();
  const drop = (sessionId: string) => {
    void disconnect(sessionId).catch(() => {});
  };
  return {
    acquire(key, connect) {
      const existing = sessions.get(key);
      if (existing !== undefined) return existing;
      const gen = generation;
      const pending = connect().then(
        (sessionId) => {
          if (gen !== generation) {
            drop(sessionId);
            throw new Error("session pool released");
          }
          return sessionId;
        },
        (e: unknown) => {
          if (sessions.get(key) === pending) sessions.delete(key);
          throw e;
        },
      );
      sessions.set(key, pending);
      return pending;
    },
    release() {
      generation += 1;
      const held = [...sessions.values()];
      sessions.clear();
      for (const p of held) {
        // 接続中のものは acquire 側が世代違いを見て切断する。完了済みのものはここで切断する。
        void p.then(drop, () => {});
      }
    },
  };
}
