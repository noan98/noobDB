# 多段 SSH トンネル (ProxyJump 相当) と ~/.ssh/config

## 多段 SSH トンネル (ProxyJump 相当) と ~/.ssh/config の読み込み (#708)

`SshTunnel` は踏み台 (bastion/jump ホスト) を 1 段だけ経由する多段構成に対応します
(ローカル → 踏み台 → 最終 SSH ホスト → DB、計 2 ホップまで)。プロトコルレベルで
`direct-tcpip` を入れ子にする実装ではなく、**既存のローカルポートフォワード
プリミティブをそのままチェーンする**設計です: 踏み台の `SshTunnel` を先に開いて
ローカルポートを得た後、最終ホップの SSH セッションは (踏み台の実アドレスではなく)
`127.0.0.1:<踏み台の local_port>` へダイヤルして張ります。ホスト鍵の検証/記録は
**ダイヤル先ではなく各ホップ自身の実 `host:port`** を使うため (`ClientHandler::new`
に渡す識別子と実際に接続するソケットアドレスを分離)、known_hosts には従来どおり
段ごとの実サーバが `host:port fingerprint` で記録されます。

- **型**: `SshConfig` (`ssh/tunnel.rs`) に `jump: Option<Box<SshJumpConfig>>` を
  追加。`SshJumpConfig` は `SshConfig` から `remote_host`/`remote_port` と自身の
  `jump` を除いた同形の構造体 (踏み台は常に「次のホップの実アドレス」へ転送する
  ため `remote_*` は暗黙)。プロファイル側も対称に `SshProfile.jump:
  Option<SshJumpProfile>` を持ちます。
- **ライフタイム/Drop 順序**: `SshTunnel` は自身の `_upstream: Option<Box<SshTunnel>>`
  を**構造体の最後のフィールド**として保持します。Rust の構造体フィールドは
  **宣言順に drop される**ため、`impl Drop` 本体 (accept タスク/転送タスクの
  abort) が走った後、`_session` (この段の SSH セッション) → `_upstream`
  (踏み台。再帰的に同じ Drop を辿る) の順で閉じます。これにより「DB 接続 → 末段
  (target) → 先頭段 (bastion)」の順序が保証され、既存の「トンネルは DB 接続より
  先に drop しない」不変条件がチェーン全体へ自然に拡張されます。
- **エラーの段別属性化**: `ssh::tunnel::tag_hop_error` (非公開) が `AppError::Ssh`
  / `AppError::SshKey` のメッセージへ `[jump host <host>:<port>]` /
  `[ssh host <host>:<port>]` のプレフィックスを付けます。`kind()` は変えない
  (フロントの分類は従来どおり `ssh`) — メッセージだけがどちらの段の失敗かを示す
  手がかりを増やします。`AppError::SshHostKeyMismatch` は元々 `host`/`port` を
  持つため追加のタグ付けは不要で、その `host`/`port` は常に**実際に不一致が
  起きた段**の識別子です (フロントの `parseHostKeyFingerprints` がメッセージから
  これを抽出し、`App.tsx` の再信頼フローはプロファイルの主 SSH ホストではなく
  こちらを使います — 踏み台側で鍵が変わった場合に正しいエンドポイントを
  pin できるようにするため)。
- **秘密情報**: 踏み台の passphrase / password は既存の `ssh_passphrase` /
  `ssh_password` (最終ホップ用、後方互換のため名前は据え置き) とは別の keyring
  kind (`ssh_passphrase_hop0` / `ssh_password_hop0`、`profiles/secrets.rs`) に
  保存します。`profiles::secrets::delete_all` も両方を消します。
- **reconnect (#712) との整合**: `Session.reconnect_ssh: Option<SshConfig>` は
  `jump` を含めたまま非秘密フィールドのみを保持し (`reconnect_ssh_from` が両
  ホップの secrets を空文字にする)、`reopen_transport` が再接続時に**踏み台側も**
  keyring から再解決します。
- **`~/.ssh/config` の読み込み**: `ssh::config_parser` (パス非依存の純粋パーサ、
  副作用なし) が `Host` ブロックから `HostName` / `Port` / `User` /
  `IdentityFile` / `ProxyJump` を解決します。ワイルドカードパターン・`Include`・
  `Match` は非対応、"first obtained value wins" という OpenSSH 本来の規則には
  従います。IPC `resolve_ssh_config_host(alias)` (`commands/ssh.rs`) が
  `~/.ssh/config` (`%USERPROFILE%\.ssh\config`) を読んで解決し、`ProxyJump` は
  `config_parser::parse_proxy_jump` で最初の 1 ホップのみ `host`/`port`/`user` に
  分解します (本アプリのトンネルが 2 ホップまでのため)。**読み取り専用・保存時
  一度きりのコピー**であり、接続時に設定ファイルを再参照することはありません。
  `ConnectionForm` の「SSH ホスト」欄にエイリアスを入力して
  「~/.ssh/config から読み込む」を押すと、解決された値 (と `ProxyJump` があれば
  踏み台欄) がフォームへ展開されます。
