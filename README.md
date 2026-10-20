# へのへのもじもじ — 漢字福笑い

漢字を「部首ごと」または「一画ずつ」のパーツに分けて遊ぶ、福笑いのブラウザゲームです。
ひとりでも、オンラインで数人でも遊べます。

## 遊び方

### ひとりで

1. お手本の漢字が3秒間表示されるので覚えます。
2. 半紙に目隠しがかかります。下の「おぜん」からパーツをドラッグして半紙に運びます。置いたパーツは見えなくなります。
3. 全部置いたら「目隠しをとる」。元の位置からのずれで採点され、判子が押されます（名人・達筆・まずまず・へのへの・もじもじ）。

### みんなで

1. 「みんなで」タブで名前を入れて「部屋を作る」。4文字の部屋コードと招待リンクができます。
2. 招待リンク（またはコード）を友だちに送ります。
3. 部屋を作った人（親）が分け方・目隠しを決めて「はじめる」。全員に同じお題が同時に出ます。
4. 答え合わせが済んだ人から「みんなの作品」で全員の並べ方と点数を見比べられます。
5. 親が「次のお題」を押すと次の回へ進みます。親が抜けると、次に早く入った人が親になります。

## 動かし方

ビルド不要の静的ページです。GitHub Pages（Settings → Pages → Branch: `main` / `/ (root)`）で公開できます。

「みんなで」を使うには、無料の Firebase Realtime Database の設定が一度だけ必要です（下記）。

## Firebase の設定（みんなで用）

1. <https://console.firebase.google.com/> で「プロジェクトを追加」（Google アナリティクスは不要）。
2. 左メニュー「構築 → Realtime Database」→「データベースを作成」。場所はシンガポール（asia-southeast1）など近いところ、モードは「ロックモード」で作成。
3. Realtime Database の「ルール」タブに、このリポジトリの `database.rules.json` の中身を貼り付けて「公開」。
4. プロジェクトの設定（歯車）→「マイアプリ」でウェブアプリ（`</>`）を追加し、表示された `firebaseConfig` の中身を `firebase-config.js` の `null` と置き換えて保存・プッシュ。

`apiKey` などはブラウザに公開される前提の値なので、リポジトリに入れて問題ありません。データへのアクセスは `database.rules.json` のルールで `rooms/` の下だけに制限しています。部屋コードを知っている人は誰でも参加・書き込みできる、パーティーゲーム向けのゆるい設定です。

### Firebase なしで動作確認する

URL の末尾に `?mock=1` を付けると、同じブラウザのタブ同士で部屋を共有する疑似サーバーで動きます（例: `index.html?mock=1` を2つのタブで開き、片方で部屋を作ってもう片方で入る）。

## ファイル構成

| ファイル | 内容 |
| --- | --- |
| `index.html` | 画面（HTML / CSS） |
| `app.js` | ゲームの処理（パーツ・採点・ひとりで・みんなで） |
| `firebase-config.js` | Firebase の接続設定（各自で記入） |
| `database.rules.json` | Realtime Database のセキュリティルール |
| `kanji-data.js` | 漢字ごとの画データとパーツ分け（自動生成） |
| `tools/build_data.py` | KanjiVG の SVG から `kanji-data.js` を作るスクリプト |

### 漢字を増やす

```sh
# KanjiVG の kanji/ フォルダから必要な SVG（例: 0660e.svg）を取得しておく
python3 tools/build_data.py <KanjiVGのkanjiフォルダ> kanji-data.js 休明好林森...
```

## クレジット

漢字の字形データは [KanjiVG](https://kanjivg.tagaini.net/)（© Ulrich Apel）を使用しています。
KanjiVG は [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) で提供されているため、`kanji-data.js` も同じライセンスに従います。
