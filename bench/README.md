# 評価ツール

判定の閾値を変えたら、実写と合成画像で前後を比べられる。コマンドはリポジトリの最上位で実行する。結果の記録は `docs/history.md`。写真は Wikimedia Commons から取得して手元だけで使う（`bench/data/` は git 管理外）。Python は PIL（Pillow）入りのもの（例：Homebrew の `python3`）を使う。

```bash
python3 -I bench/fetch.py                                   # 写真を取得（数分、途中から再開可）
python3 -I bench/views.py bench/data/photos bench/data/views  # 写真をスマホ画面相当に切り出す
python3 -I bench/scenes.py bench/data/photos bench/data/scenes 300          # 実写背景＋模様の合成（正解つき）
python3 -I bench/scenes.py bench/data/photos bench/data/rows 150 3 --kinds row  # 並びだけ
python3 -I bench/scenes.py bench/data/photos bench/data/seq 40 1 --seq 20    # 手持ちの連続フレーム
node bench/eval.mjs src/detect/detector.js bench/data/scenes       # 種類ごとの検出率・模様の外の誤反応
node bench/seq.mjs src/detect/detector.js src/track/tracker.js bench/data/seq '{"rowSplit":2}'  # 鳴るまでの時間・誤ループ/分
node bench/browser.mjs http://127.0.0.1:8000/ bench/data/b demo "720,1200,1050"  # 実ブラウザでデモを巡回
node bench/why.mjs src/detect/detector.js bench/data/nviews [ラベル,…]   # 反応しない理由（セルが最初に落ちた基準）
node bench/families.mjs src/detect/detector.js [--json out.json]     # 実写の分類ごと：格子・同心円/放射が正しく出たか、縞に格子・模様なしに何か出たか
node bench/families.mjs src/detect/detector.js --labels bench/labels.json  # 目で付けた正解で：写っているビューで正しい種類がその上に出たか、写っていないビューに出たか
python3 -I bench/labelsheet.py <ラベル> out.png [all|rest]      # 正解を付けるための一覧画像（ラベル用のマス目 A1〜 を描く）
node bench/video.mjs bench/data/phoneseq bench/data/phone/*.mov  # スマホの動画を 10 Hz のフレーム列に（ヘッドレスの Chrome で再生しながら。seq.mjs で使える）
node bench/abtime.mjs <旧>/src/detect/detector.js "$PWD/src/detect/detector.js" bench/data/views  # 解析時間を交互に 5 回ずつ測り、最速どうしで比べる
node bench/page.mjs "http://127.0.0.1:8000/bench/follow.html?seqs=8&photos=zebra_0.jpg,facade_0.jpg"  # 枠が面からずれる量（追従あり／なし）、面の傾き
node bench/page.mjs "http://127.0.0.1:8000/bench/surfaces.html?seqs=6"   # 壁＋床の場面：面の分け方、面ごとの追従
bench/sweep.sh '{}' '{"sensitivity":2}'                         # 設定違いを並べて比較
```

ヘッドレスの Chrome を使うスクリプト（`page.mjs`・`browser.mjs`・`video.mjs`）は、起動と接続を `bench/chrome.mjs` にまとめてある。検出の枠を画面単位に直すのは、アプリと同じ `toViewUnits`（`src/track/tracker.js`）を使う（評価だけ直し忘れて測りまちがえることがないように）。

写真の分類名（「レンガ」「柵」など）は、切り出したビューに本当にその模様が写っているかを表さない。`bench/labels.json` は、ビューを目で見て付けた正解（格子：写真ごとに 5 ビュー、23 分類の 435 ビュー。同心円・放射：年輪・花は全ビュー、ほかは写真ごとに 5 ビュー、10 分類の 225 ビュー）。写真そのものは入れず、ビューの名前とラベル用のマス目の範囲（`"A2:D7"`）だけを持つ。
