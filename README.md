# Ostinascope — prototype

> 身の回りの視覚的リズムを、繰り返しのパターンの中から発見する。

> Ostinato : 同じ音型を「執拗に」繰り返す、という意味の音楽用語。

スマホのカメラ映像から**繰り返しパターン**（縞・格子・点の並び・同心円／放射、似たものの並び）を検出し、種類に応じたループを鳴らす Web アプリ。スマホを動かすことがそのまま作曲／ミックスをするような体験となる。

ビルド不要の静的サイト（ES Modules）。依存パッケージなし。

---

## 動かす

| 目的                           | コマンド                                      | 開く URL                                                                                |
| ------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| PC で試す（デモポスター）      | `python3 scripts/serve.py`                    | http://localhost:8000/?mode=demo                                                        |
| PC のカメラで試す              | 同上                                          | http://localhost:8000/                                                                  |
| スマホ実機で試す（同じ Wi-Fi） | `python3 scripts/serve.py --https`            | 表示される `https://<LAN-IP>:8443/`                                                     |
| テスト                         | `npm test`（= `node --test test/*.test.mjs`） | —                                                                                       |
| ポスターの紙面を編集           | `python3 tools/poster-editor/serve.py`        | http://localhost:8010/tools/poster-editor/ （使い方は `tools/poster-editor/README.md`） |

- カメラは **HTTPS か localhost** でしか使えない。`--https` は自己署名証明書を `.cert/` に作る（git 管理外）。iPhone では警告画面で「詳細を表示 → このWebサイトを閲覧」。
- iPhone は「タップして開始」で音が有効になる。消音スイッチ ON でも鳴るよう `navigator.audioSession` を設定済み（iOS 16.4+）。
- URL に `?debug` を付けると解析セルと統計を表示し、コンソールから `window.ostinascope` で内部状態を触れる。
- 枠をカメラの動きに合わせて動かす「追従」は既定でオン。設定パネルのチェック、または URL の `?nofollow` で切れる（比べるとき用）。
- 公開：`main` にプッシュすると、テストのあと Cloudflare（https://ostinascope.shibagaki16.jp/）に公開される。詳しくは `docs/publish.md`。

### デモモード

カメラなしで、生成したポスター（パターン標本）を「カメラで覗いている」状態をシミュレートする。
ドラッグで移動、ホイール／ピンチで拡大縮小、6 秒放置で自動巡回。設定パネルから任意の画像を読み込んだり、デモポスターを印刷用 PNG（3600×5092）で保存して実機テストに使える。

---

## フォルダの構成

```
index.html              アプリの 1 ページ（開始画面・設定パネル）
sw.js                   Service Worker（毎回サーバに確かめる・オフラインでも開く）
src/                    アプリ本体（ブラウザでそのまま動く ES Modules）
  main.js               入口：取り込み → 解析 → 追跡 → 発音 → 描画の配線
  style.css             開始画面・設定パネルの見た目
  util.js               共通の小さな計算（角度・比・乱数・箱の重なり）
  homography.js         3×3 射影変換（検出と追跡で共通）
  detect/               カメラの画から繰り返しを見つける（DOM 非依存、Node でテスト可）
    detector.js         縞・格子・点・同心円・放射
    rows.js             似たものの並び、似た物の 2 次元の並び（格子）
    centers.js          同心円・放射を画素ごとの輪郭の向きから探す
    plane.js            模様の歪み方から面の傾き（消失線・法線・正面から見た形）
    fft.js              基数 2 FFT・実数画像のパワースペクトル
    color.js            領域の色（→ 音高）
    analysis.js         解析の受け渡し（Worker が使えなければメインスレッドで）
    analysis-worker.js  Worker 側：detector を回す
  track/                見つけた模様を時間方向に追う（DOM 非依存）
    tracker.js          ID の追跡（数フレームで確定、見失ったらフェード）
    motion.js           カメラの動き（角の追跡＋RANSAC で射影変換、動きで面を分ける）
    follow.js           トラックを面ごとの動きで動かす（アプリと評価で共通）
  sound/                模様 → ループ
    mapping.js          パターンの性質 → 拍・音高・音色・音量・定位（純粋関数）
    audio.js            Web Audio のエンジン
  app/                  画面・入力・版
    render.js           検出の枠・注記・演奏バーの描画
    sources.js          カメラ／デモ画像
    update.js           Service Worker の登録・版の表示・新しい版の知らせ・「最新版に更新」
    build.js            版（公開時に scripts/build-site.sh が書き込む。手元では null）
  poster/               デモポスター
    poster.js           紙面の描画（要素の種類・項目・描き方）
    qr.js               QR コード（外部のライブラリなし）
poster/poster.json      デモポスターの紙面データ（配色と要素の並び）
tools/poster-editor/    ポスター編集ツール（アプリからは独立。消してもアプリは動く）
test/                   テスト（合成画像による検出、追跡・マッピング・ポスターデータ）
bench/                  評価ツール。写真や結果は bench/data/ に置き、git 管理外
scripts/serve.py        開発サーバ（--https で LAN 向け自己署名 HTTPS）
scripts/build-site.sh   公開するものを _site/ に集め、版を書き込む（Cloudflare が公開時に実行）
wrangler.jsonc          Cloudflare への公開の設定
docs/                   仕組み・公開・改善の記録・まだ確かめていないこと
.github/workflows/      テストと、前の URL（GitHub Pages）から新しい URL への案内
```

公開するのは `index.html`・`sw.js`・`src/`・`poster/` の 4 つだけ。公開先の URL（ポスターの QR コードが指す先）を変えないよう、この 4 つは最上位に置いている。

---

## ドキュメント

| 文書                            | 中身                                                                       |
| ------------------------------- | -------------------------------------------------------------------------- |
| `docs/how-it-works.md`          | 仕組み（検出・並び・面の傾き・カメラの動き・追跡・音）と、調整できるところ |
| `docs/publish.md`               | Cloudflare への公開と、スマホで古い版が動かないための仕組み               |
| `docs/history.md`               | 改善の記録：何を変えて、どう測り、どう変わったか                           |
| `docs/todo.md`                  | まだ確かめていないこと（企画書の「検証すること」に対応）                   |
| `bench/README.md`               | 評価ツールの使い方（写真の取得、合成画像、検出率・誤反応・追従の測り方）   |
| `tools/poster-editor/README.md` | ポスター編集ツールの使い方と、紙面の要素の種類                             |
