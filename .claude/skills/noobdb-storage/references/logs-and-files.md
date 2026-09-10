# ログシステムとファイル読み書き

## ログシステム

`logs.rs` が `tracing` のイベントを `<data_dir>/noobdb.log` に書き込む**ファイルバックド
ログシンク** (`LogStore` + `MakeWriter` 実装の `LogWriter`) です。総容量 ~1 MiB を
active + backup の 2 セグメントで回し、active が半分に達したら rename してローテートします。
`lib.rs` 起動時に `logs::init()` を呼び、data_dir が取れない環境では stdout のみへ graceful
fallback します。`commands/logs.rs` の `read_logs` / `clear_logs` が設定画面のログビューア
向けに内容 (両セグメント連結) とファイルパスを返し、クリアします。

## ファイル読み込み

`commands/file.rs` の `read_text_file` は、エディタへドラッグ&ドロップされた `.sql` /
`.txt` ファイルをバックエンド経由で読み込むコマンドです。フロントから fs プラグインを
直接叩かず capabilities を最小に保つのが目的で、サイズ上限 8 MiB (`MAX_TEXT_FILE_BYTES`)、
不正 UTF-8 はロッシーデコード、空パス/不存在は拒否します。同ファイルの
`write_binary_file` は逆方向で、フロントが生成したバイト列 (チャート/ER 図の PNG・SVG
など。#643) を保存ダイアログ (`dialog:allow-save`) で選んだパスへ書き出します。同じく
fs プラグインを使わず capabilities を増やさないための経路で、サイズ上限 32 MiB
(`MAX_WRITE_FILE_BYTES`)・空パスを拒否します。チャート (`ChartView`) と ER 図
(`ERDiagramView`) の画像エクスポートは `components/imageExport.ts` (`html-to-image`
で計算済みスタイルを焼き込み、テーマ色をライト/ダーク両対応で反映) と
`components/ImageExportButton.tsx` (PNG 保存 / SVG 保存 / クリップボードコピーの
メニュー) が担い、ER 図は `getNodesBounds` で全景を `scale(1)` で書き出すため現在の
ズーム/パンに依存しません。
