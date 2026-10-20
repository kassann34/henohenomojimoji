# へのへのもじもじ — 漢字福笑い

漢字を「部首ごと」または「一画ずつ」のパーツに分けて遊ぶ、福笑いのブラウザゲームです。

## 遊び方

1. お手本の漢字が3秒間表示されるので覚えます。
2. 半紙に目隠しがかかります。下の「おぜん」からパーツをドラッグして半紙に運びます。置いたパーツは見えなくなります。
3. 全部置いたら「目隠しをとる」。元の位置からのずれで採点され、判子が押されます（名人・達筆・まずまず・へのへの・もじもじ）。

設定

- **分け方**: 部首ごと / 一画ずつ
- **目隠し**: あり / なし（練習）

## 動かし方

ビルド不要の静的ページです。`index.html` をブラウザで開くか、GitHub Pages（Settings → Pages → Branch: `main` / root）で公開できます。

## ファイル構成

| ファイル | 内容 |
| --- | --- |
| `index.html` | ゲーム本体（HTML / CSS / JavaScript） |
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
