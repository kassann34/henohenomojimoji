"""KanjiVG の SVG から、ゲーム用のパーツデータ (kanji-data.js) を生成する。

使い方: python3 build_data.py <kanjivg_svg_dir> <out.js> <漢字列>
"""
import json
import re
import sys
import xml.etree.ElementTree as ET

SVG = "{http://www.w3.org/2000/svg}"


def attr(el, name):
    for k, v in el.attrib.items():
        if k.endswith("}" + name) or k == "kvg:" + name:
            return v
    return None


def strokes_in(el, order):
    return [order[id(p)] for p in el.iter(SVG + "path")]


def parse(path, ch):
    raw = open(path, encoding="utf-8").read()
    raw = re.sub(r"<!DOCTYPE.*?\]>", "", raw, flags=re.S)
    root = ET.fromstring(raw)
    stroke_group = next(g for g in root.iter(SVG + "g") if g.get("id", "").startswith("kvg:StrokePaths"))
    paths = list(stroke_group.iter(SVG + "path"))
    order = {id(p): i for i, p in enumerate(paths)}
    strokes = [p.get("d") for p in paths]
    main = stroke_group[0]

    def children_units(g):
        return [c for c in g if c.tag in (SVG + "g", SVG + "path")]

    def expandable(g):
        # 子がすべてグループ（＝構成要素）のときだけ分解する。画がむき出しの要素は分解しない
        ch = children_units(g)
        return g.tag == SVG + "g" and len(ch) >= 2 and all(c.tag == SVG + "g" for c in ch)

    # 部首（構成要素）単位: メイングループの子から始め、3パーツ以上になるまで大きい要素を分解
    units = children_units(main)
    while len(units) < 3:
        cand = [u for u in units if expandable(u)]
        if not cand:
            break
        big = max(cand, key=lambda u: len(strokes_in(u, order)))
        i = units.index(big)
        kids = children_units(big)
        for k in kids:
            if not attr(k, "element") and attr(big, "element"):
                k.set("kvg:element", attr(big, "element"))
        units[i:i + 1] = kids

    # kvg:part で分割された同一要素（例: 衣が上下に分かれる）を統合
    parts, merged = [], {}
    for u in units:
        name = attr(u, "element") if u.tag == SVG + "g" else None
        idx = strokes_in(u, order)
        key = (name, attr(u, "original")) if (u.tag == SVG + "g" and attr(u, "part")) else None
        if key and key in merged:
            merged[key]["s"] += idx
            continue
        part = {"n": name or "", "s": idx}
        if key:
            merged[key] = part
        parts.append(part)

    for p in parts:
        p["s"].sort()
    return {"c": ch, "strokes": strokes, "parts": parts}


def main():
    src, out, chars = sys.argv[1], sys.argv[2], sys.argv[3]
    data = [parse(f"{src}/{ord(c):05x}.svg", c) for c in chars]
    for d in data:
        print(d["c"], len(d["strokes"]), "画", [p["n"] or "・" for p in d["parts"]])
    header = (
        "// 漢字のストロークデータは KanjiVG (https://kanjivg.tagaini.net/) を使用しています。\n"
        "// Copyright (C) 2009-2023 Ulrich Apel. Licensed under CC BY-SA 3.0.\n"
        "// このファイルは tools/build_data.py で生成されています。\n"
    )
    with open(out, "w", encoding="utf-8") as f:
        f.write(header + "window.KANJI_DATA = " + json.dumps(data, ensure_ascii=False) + ";\n")


main()
