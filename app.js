// へのへのもじもじ — 漢字福笑い
// 1. Engine  : 半紙とパーツの描画、ドラッグ、採点（ひとりでも、みんなでも共通）
// 2. Backend : 部屋のデータを置く場所（Firebase Realtime Database。?mock=1 のときは同じブラウザ内の疑似サーバー）
// 3. SetPlay : 4字で1セットの進行と、四字熟語の結果表示
// 4. Solo / Online : あそびかたごとの進行（みんなでは全員同時に1字ずつ）
(() => {
  "use strict";
  const DATA = window.KANJI_DATA || [];
  const VB = 109; // KanjiVG の座標系（109×109）
  const NS = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const byChar = (c) => DATA.find((k) => k.c === c);
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ======================================================================
  // 1. Engine
  // ======================================================================
  const stage = $("stage"), board = $("board"), tray = $("tray");

  /** 漢字と分け方から、パーツ（画番号の配列）の一覧を作る。全員で同じ結果になる */
  function groupsFor(kanji, mode) {
    return mode === "parts" && kanji.parts.length > 1
      ? kanji.parts.map((p) => p.s)
      : kanji.strokes.map((_, i) => [i]);
  }
  function pathsOf(kanji, idx) {
    return idx.map((i) => `<path d="${kanji.strokes[i]}"/>`).join("");
  }
  const allIdx = (kanji) => kanji.strokes.map((_, i) => i);
  // 置かなかった画（時間切れでおぜんに残った画）は [-999, -999] で表す
  const UNPLACED = [-999, -999];
  const validPos = (p) => Array.isArray(p) && p.length === 2 && p[0] > -500;
  /** 保存された位置の並び（配列でも {0:..,1:..} でも）を、画の数ぶんの配列にそろえる */
  const posList = (v, n) => Array.from({ length: n }, (_, i) => (v && validPos(v[i]) ? v[i] : UNPLACED));

  const bboxCache = new Map();
  function measure(kanji, idx) {
    const key = kanji.c + ":" + idx.join(",");
    if (bboxCache.has(key)) return bboxCache.get(key);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${VB} ${VB}`);
    svg.style.cssText = "position:absolute;visibility:hidden;width:109px;height:109px;left:-999px";
    svg.innerHTML = pathsOf(kanji, idx);
    document.body.appendChild(svg);
    const b = svg.getBBox();
    svg.remove();
    const pad = 3;
    const bb = { x: b.x - pad, y: b.y - pad, w: b.width + pad * 2, h: b.height + pad * 2 };
    bboxCache.set(key, bb);
    return bb;
  }

  // ---------- 採点（シルエット比較） ----------
  // お手本と並べた結果をそれぞれ白黒画像にして、墨どうしの距離を測る。
  // ・どのパーツをどこに置いたかは問わない（晶の「日」を入れ替えても満点になる）
  // ・字全体の重心を合わせてから比べるので、半紙の上で全体がずれただけなら減点しない
  // d（墨どうしの平均距離、KanjiVG単位。tol 以内の細かい字形の違いは数えない）→ 点数 = 100·exp(-(d/scale)^power)
  // 目安（35字で試算）: 各パーツ±3ずれ→約97点、±8ずれ→約85点、±15ずれ→約45点、でたらめ→約15点
  const SIL = { margin: 30, px: 160, stroke: 4.4, tol: 1.5, scale: 2.0, power: 1.5 };
  const SIL_SCALE = SIL.px / (VB + SIL.margin * 2);

  // 白黒画像はキャンバスを使わず自前で描く（キャンバスの読み出しは、まれにずれた画像を返すことがあったため）。
  // 各画の線を細かい点に分けておき、点ごとに筆の太さの円を押していく。
  const strokePts = new Map();
  let sampler = null;
  function strokePoints(kanji, i) {
    const key = kanji.c + ":" + i;
    let pts = strokePts.get(key);
    if (pts) return pts;
    if (!sampler) {
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${VB} ${VB}`);
      svg.style.cssText = "position:absolute;visibility:hidden;width:109px;height:109px;left:-999px;top:0";
      sampler = document.createElementNS(NS, "path");
      svg.appendChild(sampler);
      document.body.appendChild(svg);
    }
    sampler.setAttribute("d", kanji.strokes[i]);
    const len = sampler.getTotalLength();
    const n = Math.max(2, Math.ceil(len / 0.5));
    pts = new Float32Array(n * 2);
    for (let j = 0; j < n; j++) {
      const q = sampler.getPointAtLength((len * j) / (n - 1));
      pts[j * 2] = q.x;
      pts[j * 2 + 1] = q.y;
    }
    strokePts.set(key, pts);
    return pts;
  }
  let brush = null; // 筆の太さの円に入るマスのずれ
  function brushOffsets() {
    if (brush) return brush;
    const r = (SIL.stroke / 2) * SIL_SCALE;
    const R = Math.ceil(r);
    const list = [];
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) if (x * x + y * y <= r * r + 0.25) list.push(x, y);
    brush = Int32Array.from(list);
    return brush;
  }

  /** パーツを描いた墨のマスク（1 = 墨）と重心を返す。offset は全体をずらす量（KanjiVG単位）。
   *  ごくまれに描いた画像全体がずれることがあったため、点の座標から求めた中心と画像の中心を見比べ、
   *  食い違っていたら描き直す。 */
  function inkMask(kanji, groups, positions, offset) {
    // 配列のまま渡さず、数値にして渡す（最適化後の配列の読み違いを避ける）
    const offX = +offset[0] || 0, offY = +offset[1] || 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const m = drawMask(kanji, groups, positions, offX, offY);
      if (!m.n || (Math.abs(m.cx - m.ex) < 4 && Math.abs(m.cy - m.ey) < 4)) return m;
      if (window.HHMM) (window.HHMM.retries = window.HHMM.retries || []).push([kanji.c, Math.round(m.cx - m.ex), Math.round(m.cy - m.ey)]);
    }
    return drawMask(kanji, groups, positions, offX, offY);
  }

  // 最適化の影響を受けにくいよう、コールバックや配列の分割代入を使わない素直なループで書く
  function drawMask(kanji, groups, positions, offX, offY) {
    const W = SIL.px, S = SIL_SCALE, M = SIL.margin;
    const mask = new Uint8Array(W * W);
    const br = brushOffsets();
    let pn = 0, px = 0, py = 0; // 点の座標から求める、墨の中心の見込み
    for (let gi = 0; gi < groups.length; gi++) {
      const idx = groups[gi];
      let dx = 0, dy = 0;
      if (positions !== null) {
        const p = positions[gi];
        if (!validPos(p)) continue;
        const bb = measure(kanji, idx);
        dx = p[0] - bb.x;
        dy = p[1] - bb.y;
      }
      const ox = M + offX + dx, oy = M + offY + dy;
      for (let k = 0; k < idx.length; k++) {
        const pts = strokePoints(kanji, idx[k]);
        let lastX = -1, lastY = -1;
        for (let j = 0; j < pts.length; j += 2) {
          const X = (pts[j] + ox) * S, Y = (pts[j + 1] + oy) * S;
          if (X >= 0 && Y >= 0 && X < W && Y < W) { pn++; px += X; py += Y; }
          const cx = Math.round(X), cy = Math.round(Y);
          if (cx === lastX && cy === lastY) continue;
          lastX = cx; lastY = cy;
          for (let b = 0; b < br.length; b += 2) {
            const x = cx + br[b], y = cy + br[b + 1];
            if (x >= 0 && y >= 0 && x < W && y < W) mask[y * W + x] = 1;
          }
        }
      }
    }
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1) { n++; sx += i % W; sy += (i - (i % W)) / W; }
    }
    return { mask, n, cx: n ? sx / n : 0, cy: n ? sy / n : 0, ex: pn ? px / pn : 0, ey: pn ? py / pn : 0 };
  }

  /** 各マスから最も近い墨までの距離（ピクセル、3-4 チャムファー距離） */
  function distanceMap(mask) {
    const W = SIL.px, INF = 1e9;
    const d = new Float32Array(mask.length);
    for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 3);
      if (y > 0) {
        d[i] = Math.min(d[i], d[i - W] + 3);
        if (x > 0) d[i] = Math.min(d[i], d[i - W - 1] + 4);
        if (x < W - 1) d[i] = Math.min(d[i], d[i - W + 1] + 4);
      }
    }
    for (let y = W - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + 3);
      if (y < W - 1) {
        d[i] = Math.min(d[i], d[i + W] + 3);
        if (x < W - 1) d[i] = Math.min(d[i], d[i + W + 1] + 4);
        if (x > 0) d[i] = Math.min(d[i], d[i + W - 1] + 4);
      }
    }
    for (let i = 0; i < d.length; i++) d[i] /= 3;
    return d;
  }

  function meanDist(mask, dmap) {
    let s = 0, n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { s += Math.max(0, dmap[i] - SIL.tol * SIL_SCALE); n++; } // 細かい字形の違い（tol 以内）は数えない
    return n ? s / n : Infinity;
  }

  const modelCache = new Map();
  /** 並べ方を採点する（0〜100）。positions[i] はパーツ i の左上（KanjiVG単位） */
  function scoreArrangement(kanji, mode, positions) {
    const groups = groupsFor(kanji, mode);
    const key = kanji.c + ":" + mode;
    let model = modelCache.get(key);
    if (!model) {
      const whole = inkMask(kanji, [allIdx(kanji)], null, [0, 0]);
      model = {
        whole, dmap: distanceMap(whole.mask),
        pieces: groups.map((idx) => inkMask(kanji, [idx], null, [0, 0]).mask),
      };
      // お手本が空で描けてしまった場合は覚えておかない（次回また描き直す）
      if (whole.n > 0 && model.pieces.every((m) => m.some((v) => v))) modelCache.set(key, model);
    }
    const first = inkMask(kanji, groups, positions, [0, 0]);
    if (!first.n) return 0; // 1画も置いていない
    const shift = [(model.whole.cx - first.cx) / SIL_SCALE, (model.whole.cy - first.cy) / SIL_SCALE];
    const mine = inkMask(kanji, groups, positions, shift);
    const mineD = distanceMap(mine.mask);
    // パーツごとに距離を測って平均する（小さいパーツも大きいパーツと同じ重さ）
    //  ・自分の各パーツ → お手本の墨：余計なところに置いたパーツを減点
    //  ・お手本の各パーツ → 自分の墨：あるべき場所に墨がないのを減点
    // どちらも「どのパーツか」は問わず墨全体と比べるので、同じ形の部品の入れ替えは減点されない
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const placed = groups.map((idx, i) => i).filter((i) => validPos(positions[i]));
    const extra = avg(placed.map((i) => meanDist(inkMask(kanji, [groups[i]], [positions[i]], shift).mask, model.dmap)));
    const missing = avg(model.pieces.map((m) => meanDist(m, mineD)));
    const d = (extra + missing) / 2 / SIL_SCALE;
    return Math.round(100 * Math.exp(-Math.pow(d / SIL.scale, SIL.power)));
  }

  function rankOf(score, c) {
    return score >= 90 ? ["名人", `どこから見ても「${c}」。お見事です。`]
      : score >= 75 ? ["達筆", "ほぼ完璧。ちょっとの癖が味になっています。"]
      : score >= 55 ? ["まずまず", "読めます。たぶん。"]
      : score >= 35 ? ["へのへの", "福笑いとしては大成功です。"]
      : ["もじもじ", "新しい漢字が生まれました。"];
  }

  /** 並べた結果を小さな半紙の SVG にする（みんなの作品で使う） */
  function arrangementSvg(kanji, mode, positions, withGhost) {
    const groups = groupsFor(kanji, mode);
    const inner = groups.map((idx, i) => {
      const bb = measure(kanji, idx);
      if (!validPos(positions[i])) return "";
      const [x, y] = positions[i];
      return `<g transform="translate(${(x - bb.x).toFixed(2)} ${(y - bb.y).toFixed(2)})">${pathsOf(kanji, idx)}</g>`;
    }).join("");
    const ghost = withGhost ? `<g class="ghost">${pathsOf(kanji, allIdx(kanji))}</g>` : "";
    return `<svg viewBox="0 0 ${VB} ${VB}" xmlns="${NS}">${ghost}${inner}</svg>`;
  }

  const Engine = (() => {
    const st = { kanji: null, mode: "strokes", blind: true, pieces: [], phase: "idle", ghost: null };
    let hooks = {};
    let L = {};
    let timer = null;
    let zTop = 1;

    function layout() {
      const W = stage.clientWidth;
      const S = Math.min(W, 380);
      const u = S / VB, gap = 14, trayH = Math.round(S * 0.62);
      L = { W, S, u, bx: (W - S) / 2, trayTop: S + gap, trayH };
      stage.style.height = (S + gap + trayH) + "px";
      Object.assign(board.style, { left: L.bx + "px", width: S + "px", height: S + "px" });
      Object.assign(tray.style, { top: L.trayTop + "px", height: trayH + "px" });
      st.pieces.forEach(placeEl);
    }

    function clearPieces() {
      stage.querySelectorAll(".piece").forEach((e) => e.remove());
      st.pieces = [];
    }

    function buildPieces() {
      clearPieces();
      const k = st.kanji;
      st.pieces = groupsFor(k, st.mode).map((idx) => {
        const bb = measure(k, idx);
        const el = document.createElement("div");
        el.className = "piece offboard";
        el.innerHTML = `<svg viewBox="${bb.x} ${bb.y} ${bb.w} ${bb.h}" xmlns="${NS}">${pathsOf(k, idx)}</svg>`;
        const p = { el, bb, idx, x: 0, y: 0, placed: false };
        attachDrag(p);
        stage.appendChild(el);
        return p;
      });
      scatterAll(st.pieces);
      st.pieces.forEach(placeEl);
    }

    // おぜんをマス目に分け、各パーツの中心をばらばらのマスに置く（重なりを減らす）
    function scatterAll(list) {
      const W = L.W / L.u, top = L.trayTop / L.u + 12, H = L.trayH / L.u - 14, bx = L.bx / L.u;
      const n = list.length;
      const cols = Math.max(1, Math.round(Math.sqrt(n * W / H)));
      const rows = Math.ceil(n / cols);
      const cells = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([c, r]);
      cells.sort(() => Math.random() - 0.5);
      const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
      list.forEach((p, i) => {
        const [c, r] = cells[i];
        const cw = W / cols, ch = H / rows;
        const cx = (c + 0.5 + (Math.random() - 0.5) * 0.5) * cw;
        const cy = (r + 0.5 + (Math.random() - 0.5) * 0.5) * ch;
        p.x = clamp(cx - p.bb.w / 2, 2, W - p.bb.w - 2) - bx;
        p.y = clamp(top + cy - p.bb.h / 2, top, top + H - p.bb.h);
      });
    }

    function placeEl(p) {
      const { u, bx } = L;
      Object.assign(p.el.style, {
        left: (bx + p.x * u) + "px", top: (p.y * u) + "px",
        width: (p.bb.w * u) + "px", height: (p.bb.h * u) + "px",
      });
    }

    function onBoard(p) {
      const cx = p.x + p.bb.w / 2, cy = p.y + p.bb.h / 2;
      return cx >= 0 && cx <= VB && cy >= 0 && cy <= VB;
    }

    function attachDrag(p) {
      let sx, sy, ox, oy, id = null;
      p.el.addEventListener("pointerdown", (e) => {
        if (st.phase !== "play") return;
        id = e.pointerId;
        p.el.setPointerCapture(id);
        p.el.style.zIndex = String(++zTop);
        sx = e.clientX; sy = e.clientY; ox = p.x; oy = p.y;
        p.el.classList.add("dragging");
        e.preventDefault();
      });
      p.el.addEventListener("pointermove", (e) => {
        if (e.pointerId !== id) return;
        p.x = ox + (e.clientX - sx) / L.u;
        p.y = oy + (e.clientY - sy) / L.u;
        placeEl(p);
        const on = onBoard(p);
        p.el.classList.toggle("onboard", on);
        p.el.classList.toggle("offboard", !on);
      });
      const end = (e) => {
        if (e.pointerId !== id) return;
        id = null;
        p.el.classList.remove("dragging");
        p.placed = onBoard(p);
        if (p.placed && st.blind) p.el.classList.add("hiddenplace");
        status();
      };
      p.el.addEventListener("pointerup", end);
      p.el.addEventListener("pointercancel", end);
    }

    /** 半紙とおぜんを表示する（四字熟語の結果表示から戻るとき） */
    function showStage() {
      document.querySelectorAll(".screen").forEach((e) => (e.hidden = true));
      if (stage.hidden) { stage.hidden = false; layout(); }
    }
    function hideStage() {
      clearInterval(timer);
      clearPieces();
      st.phase = "done";
      stage.hidden = true;
      $("result").hidden = true;
    }

    const boardSvg = (inner, cls = "") => `<svg class="big ${cls}" viewBox="0 0 ${VB} ${VB}" xmlns="${NS}">${inner}</svg>`;

    function status() {
      const total = st.pieces.length;
      const placed = st.pieces.filter((p) => p.placed).length;
      const el = $("status");
      const pre = hooks.prefix ? hooks.prefix() + "　" : "";
      if (st.phase === "preview") el.textContent = pre + "よく見て覚えてください";
      else if (st.phase === "play") el.textContent = pre + `${placed} / ${total} 画`;
      else if (st.phase === "reveal") el.textContent = pre + "答え合わせ";
      else el.textContent = "";
      if (st.phase === "play") {
        setActions([[st.blind ? "目隠しをとる" : "答え合わせ", "primary", reveal, placed < total]]);
      }
    }

    /** お題を出す。opts: { mode, blind } */
    function start(kanji, opts) {
      clearInterval(timer);
      st.kanji = kanji;
      st.mode = opts.mode;
      st.blind = opts.blind;
      st.phase = "preview";
      st.ghost = null;
      $("result").hidden = true;
      showStage();
      buildPieces();
      st.pieces.forEach((p) => (p.el.hidden = true));
      let n = 3;
      board.innerHTML = `<div class="preview">${boardSvg(`<g>${pathsOf(kanji, allIdx(kanji))}</g>`)}<div class="count" id="count">${n}</div></div>`;
      setActions([["覚えた！", "primary", play]]);
      timer = setInterval(() => {
        n -= 1;
        const c = $("count");
        if (c) c.textContent = n;
        if (n <= 0) play();
      }, 1000);
      status();
    }

    function play() {
      clearInterval(timer);
      if (st.phase !== "preview") return;
      st.phase = "play";
      board.innerHTML = st.blind ? `<div class="cover">目隠し中</div>` : "";
      st.pieces.forEach((p) => (p.el.hidden = false));
      status();
    }

    function reveal() {
      if (st.phase !== "play" && st.phase !== "preview") return;
      clearInterval(timer);
      st.phase = "reveal";
      const cover = board.querySelector(".cover");
      st.pieces.forEach((p) => {
        p.el.classList.add("reveal");
        p.el.classList.remove("hiddenplace");
      });
      if (cover) requestAnimationFrame(() => cover.classList.add("off"));
      if (board.querySelector(".preview")) board.innerHTML = "";
      // 半紙に置いていない画（時間切れ）は採点に入れない
      const positions = st.pieces.map((p) => (p.placed ? [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10] : UNPLACED));
      const score = scoreArrangement(st.kanji, st.mode, positions);
      if (window.HHMM) window.HHMM.last = { c: st.kanji.c, mode: st.mode, positions, score };
      const rank = rankOf(score, st.kanji.c);
      setTimeout(() => {
        board.insertAdjacentHTML("beforeend",
          boardSvg(`<g class="ghost">${pathsOf(st.kanji, allIdx(st.kanji))}</g>`, "ghostlayer") +
          `<div class="stamp"><div><b style="font-size:${L.S * 0.09}px">${rank[0]}</b><b style="font-size:${L.S * 0.06}px">${score}点</b></div></div>`);
        st.ghost = board.querySelector("svg.ghostlayer");
        st.ghost.style.opacity = "0";
        st.ghost.style.transition = "opacity .4s";
      }, st.blind ? 900 : 0);
      const r = $("result");
      r.innerHTML = `<div class="title">「${st.kanji.c}」 ${score}点・${rank[0]}</div><div class="note">${rank[1]}</div>`;
      r.hidden = false;
      status();
      const ghostBtn = ["お手本を重ねる", "", (btn) => {
        if (!st.ghost) return;
        const on = st.ghost.style.opacity === "1";
        st.ghost.style.opacity = on ? "0" : "1";
        btn.textContent = on ? "お手本を重ねる" : "お手本を隠す";
      }];
      hooks.onReveal && hooks.onReveal({ kanji: st.kanji, score, rank: rank[0], positions });
      setActions([ghostBtn, ...(hooks.afterReveal ? hooks.afterReveal() : [])]);
    }

    /** お題が出ていない状態（待ち） */
    function idle(message) {
      clearInterval(timer);
      clearPieces();
      st.phase = "idle";
      st.kanji = null;
      $("result").hidden = true;
      showStage();
      board.innerHTML = `<div class="waiting">${message}</div>`;
      status();
    }

    function setHooks(h) { hooks = h || {}; }
    function refreshActions() {
      if (st.phase === "play") status();
      else if (st.phase === "reveal") {
        const keep = $("actions").firstChild;
        setActions([]);
        if (keep) $("actions").appendChild(keep);
        (hooks.afterReveal ? hooks.afterReveal() : []).forEach((a) => addAction(...a));
      }
    }

    window.addEventListener("resize", layout);
    layout();
    /** 時間切れ：その時点の配置のまま答え合わせ */
    function forceReveal() {
      if (st.phase === "preview") st.pieces.forEach((p) => (p.el.hidden = false));
      reveal();
    }

    return { start, idle, hideStage, forceReveal, setHooks, refreshActions, get phase() { return st.phase; }, get kanji() { return st.kanji; } };
  })();

  function addAction(text, cls, fn, disabled) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn " + (cls || "");
    b.textContent = text;
    b.disabled = !!disabled;
    b.addEventListener("click", () => fn(b));
    $("actions").appendChild(b);
  }
  function setActions(list) {
    $("actions").innerHTML = "";
    $("actions").dataset.key = "";
    list.forEach((a) => addAction(...a));
  }

  // 設定（分け方・目隠し）のボタン
  const settings = { mode: "strokes", blind: true }; // 分け方は「一画ずつ」に固定
  let onSettingsChange = () => {};
  function setSegValue(segId, value) {
    $(segId).querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === value)));
  }
  function showSettings() {
    setSegValue("blindSeg", settings.blind ? "on" : "off");
  }
  function lockSettings(locked) {
    document.querySelectorAll("#blindSeg button").forEach((b) => (b.disabled = locked));
  }
  $("blindSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    settings.blind = b.dataset.v === "on";
    showSettings();
    onSettingsChange();
  });

  // ======================================================================
  // 2. Backend
  // ======================================================================
  const FIREBASE_VERSION = "10.12.2";

  async function firebaseBackend(cfg) {
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const appMod = await import(`${base}/firebase-app.js`);
    const db = await import(`${base}/firebase-database.js`);
    const database = db.getDatabase(appMod.initializeApp(cfg));
    const r = (p) => db.ref(database, p);
    // 端末ごとの時計のずれを補正し、全員が同じ締め切り時刻を使えるようにする
    let offset = 0;
    db.onValue(r(".info/serverTimeOffset"), (s) => { offset = s.val() || 0; });
    return {
      now: () => Date.now() + offset,
      get: async (p) => (await db.get(r(p))).val(),
      set: (p, v) => db.set(r(p), v),
      update: (p, v) => db.update(r(p), v),
      remove: (p) => db.remove(r(p)),
      on: (p, cb) => db.onValue(r(p), (s) => cb(s.val())),
      removeOnDisconnect: (p) => db.onDisconnect(r(p)).remove(),
    };
  }

  // 動作確認用：同じブラウザのタブ同士で部屋を共有する疑似サーバー（?mock=1）
  // 値を1つずつ別のキーに保存するので、複数のタブが別々の場所へ同時に書いても上書きし合わない（Firebase と同じ）
  function mockBackend() {
    const PRE = "hhmm-mock:";
    const subs = new Set();
    const keys = () => { const ks = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(PRE)) ks.push(k); } return ks; };
    const under = (p) => keys().filter((k) => { const q = k.slice(PRE.length); return q === p || q.startsWith(p + "/"); });
    const flatten = (p, v, out) => {
      if (v !== null && typeof v === "object") Object.keys(v).forEach((k) => flatten(p + "/" + k, v[k], out));
      else if (v !== null && v !== undefined) out[p] = v;
      return out;
    };
    // {0:..,1:..} のように番号だけのものは配列に戻す（Firebase と同じ）
    const arrayify = (v) => {
      if (v === null || typeof v !== "object") return v;
      Object.keys(v).forEach((k) => (v[k] = arrayify(v[k])));
      const ks = Object.keys(v);
      if (ks.length && ks.every((k, i) => String(i) === k)) return ks.map((k) => v[k]);
      return v;
    };
    const read = (p) => {
      let root = null;
      under(p).forEach((k) => {
        const rest = k.slice(PRE.length + p.length).split("/").filter(Boolean);
        let val;
        try { val = JSON.parse(localStorage.getItem(k)); } catch (e) { return; }
        if (!rest.length) { root = val; return; }
        if (root === null || typeof root !== "object") root = {};
        let o = root;
        rest.slice(0, -1).forEach((r) => { if (typeof o[r] !== "object" || o[r] === null) o[r] = {}; o = o[r]; });
        o[rest[rest.length - 1]] = val;
      });
      return arrayify(root);
    };
    const write = (p, v) => {
      under(p).forEach((k) => localStorage.removeItem(k));
      // 親の位置に値が直接入っていたら消す
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) localStorage.removeItem(PRE + parts.slice(0, i).join("/"));
      Object.entries(flatten(p, v, {})).forEach(([k, val]) => localStorage.setItem(PRE + k, JSON.stringify(val)));
    };
    const emit = () => subs.forEach((s) => s.cb(read(s.p)));
    let pending = false;
    const soon = () => { if (!pending) { pending = true; setTimeout(() => { pending = false; emit(); }, 0); } };
    // 書き込みが全部終わってから最後に版数を更新し、他のタブは版数の変化だけを合図に読み直す
    const VER = "hhmm-mockver";
    const bump = () => localStorage.setItem(VER, String(Date.now() + Math.random()));
    window.addEventListener("storage", (e) => { if (!e.key || e.key === VER) soon(); });
    return {
      now: () => Date.now(),
      get: async (p) => read(p),
      set: async (p, v) => { write(p, v); bump(); soon(); },
      update: async (p, obj) => { Object.keys(obj).forEach((k) => write(p + "/" + k, obj[k])); bump(); soon(); },
      remove: async (p) => { write(p, null); bump(); soon(); },
      on: (p, cb) => { const s = { p, cb }; subs.add(s); setTimeout(() => cb(read(p)), 0); return () => subs.delete(s); },
      removeOnDisconnect: () => {},
    };
  }

  const params = new URLSearchParams(location.search);
  if (params.get("debug") === "1") window.HHMM = { DATA, groupsFor, measure, scoreArrangement, SIL, modelCache, bboxCache, inkMask, allIdx, strokePoints };
  const useMock = params.get("mock") === "1";
  let backendPromise = null;
  function getBackend() {
    if (!backendPromise) {
      backendPromise = useMock ? Promise.resolve(mockBackend())
        : window.FIREBASE_CONFIG ? firebaseBackend(window.FIREBASE_CONFIG)
        : Promise.reject(new Error("noconfig"));
    }
    return backendPromise;
  }
  const onlineAvailable = useMock || !!window.FIREBASE_CONFIG;

  // ======================================================================
  // 3. セット（4字で1セット。最後に自分の作った字を四字熟語として並べる）
  // ======================================================================
  const SET_SIZE = 4;

  /** ランダムに重ならない4字を選ぶ（first を指定すると1字目に固定） */
  function randomChars(first) {
    const chars = first && byChar(first) ? [first] : [];
    while (chars.length < SET_SIZE) {
      const c = DATA[Math.floor(Math.random() * DATA.length)].c;
      if (!chars.includes(c)) chars.push(c);
    }
    return chars;
  }

  const toArr = (v) => (Array.isArray(v) ? v.filter(Boolean) : Object.keys(v || {}).sort((a, b) => a - b).map((k) => v[k]));
  const totalOf = (items) => items.reduce((a, it) => a + (it.score || 0), 0);

  function yojiRank(total) {
    const avg = total / SET_SIZE;
    return avg >= 90 ? ["名人", "四字とも見事。掛け軸にして飾れます。"]
      : avg >= 75 ? ["達筆", "ちゃんと読める四字熟語です。意味はありません。"]
      : avg >= 55 ? ["まずまず", "辞書には載っていませんが、それっぽい。"]
      : avg >= 35 ? ["へのへの", "どこの国の言葉でしょう。"]
      : ["もじもじ", "誰にも読めない、あなただけの四字熟語。"];
  }

  /** 自分の作った4字を縦長の半紙に並べた HTML。size: "big" | "small" */
  function yojiSheet(items, size) {
    const cells = items.map((it) => {
      const k = byChar(it.c);
      return `<div class="cell">${k ? arrangementSvg(k, it.mode || "strokes", posList(it.pos, groupsFor(k, it.mode || "strokes").length), false) : ""}</div>`;
    }).join("");
    const total = totalOf(items);
    return `<div class="sheet ${size}">${cells}<div class="seal">${total}</div></div>`;
  }

  const SetPlay = (() => {
    let s = null; // { chars, opts, items, cb, finished }

    function begin(chars, opts, cb) {
      s = { chars, opts: { ...opts }, items: [], cb: cb || {}, finished: false };
      Engine.setHooks({
        prefix: () => `${Math.min(s.items.length + 1, SET_SIZE)}字目 / ${SET_SIZE}`,
        onReveal: ({ kanji, score, positions }) => {
          s.items.push({ c: kanji.c, score, pos: positions, mode: s.opts.mode });
          s.cb.onItem && s.cb.onItem(s.items.length - 1, s.items[s.items.length - 1]);
        },
        afterReveal: () => s.items.length < SET_SIZE
          ? [[`次の字へ（${s.items.length + 1}字目）`, "primary", next]]
          : [["四字熟語を見る", "primary", finish]],
      });
      next();
    }

    function next() {
      if (!s) return;
      if (s.items.length >= SET_SIZE) return finish();
      Engine.start(byChar(s.chars[s.items.length]), s.opts);
    }

    function finish() {
      s.finished = true;
      Engine.hideStage();
      const total = totalOf(s.items);
      const rank = yojiRank(total);
      $("status").textContent = "四字熟語のできあがり";
      $("result").innerHTML = `<div class="title">「${s.items.map((it) => esc(it.c)).join("")}」</div><div class="note">合計 ${total} / ${SET_SIZE * 100}点・${rank[0]}</div>`;
      $("result").hidden = false;
      $("yojiPanel").innerHTML = `
        <div class="yoji">
          ${yojiSheet(s.items, "big")}
          <div class="yoji-side">
            <div class="yoji-label">存在しない四字熟語</div>
            <div class="yoji-orig">${s.items.map((it) => esc(it.c)).join("")}</div>
            <ol class="yoji-scores">
              ${s.items.map((it) => `<li><span>${esc(it.c)}</span><b>${it.score}</b>点</li>`).join("")}
            </ol>
            <div class="yoji-total"><span>合計</span><b>${total}</b><span>/ ${SET_SIZE * 100}点</span></div>
            <div class="yoji-rank">${rank[0]}</div>
            <p class="note">${rank[1]}</p>
          </div>
        </div>`;
      $("yojiPanel").hidden = false;
      setActions(s.cb.finalActions ? s.cb.finalActions() : []);
      s.cb.onDone && s.cb.onDone(s.items, total);
    }

    /** 設定が変わったとき：次の字から反映。いま解き始める前なら、その字からやり直す */
    function updateOpts(opts) {
      if (!s) return;
      s.opts = { ...opts };
      if (!s.finished && (Engine.phase === "preview" || Engine.phase === "play")) next();
    }

    function refreshActions() {
      if (!s) return;
      if (s.finished) setActions(s.cb.finalActions ? s.cb.finalActions() : []);
      else Engine.refreshActions();
    }

    return {
      begin, updateOpts, refreshActions,
      stop() { s = null; Engine.setHooks({}); },
      get active() { return !!s; },
      get finished() { return !!(s && s.finished); },
    };
  })();

  // ======================================================================
  // 4a. Solo
  // ======================================================================
  const Solo = (() => {
    function newSet() {
      const chars = randomChars();
      SetPlay.begin(chars, settings, {
        finalActions: () => [["もう一セット", "primary", newSet]],
      });
    }
    function enter() {
      lockSettings(false);
      onSettingsChange = () => SetPlay.updateOpts(settings);
      newSet();
    }
    return { enter };
  })();

  // ======================================================================
  // 4b. Online（全員で同じ字に同時に挑戦する）
  //   流れ: ロビー → 1字目（制限時間）→ 1字目の結果（約5秒）→ … → 4字目の結果 → 結果発表 → ロビー
  //   進行（時間切れ・次の字・結果発表）は親の画面が見張って進める。親が抜けたら次の人が引き継ぐ。
  //
  //   rooms/{CODE} = {
  //     host, createdAt,
  //     settings: { blind },
  //     players/{pid}: { name, color, iconChar, icon: { c, pos }, joinedAt,
  //                      last: { total, rank, of, items: [{ c, score, pos }] } },   // 前回のゲーム
  //     game: { n, phase: "lobby" | "play" | "result" | "final", chars, idx, deadline, resultUntil, blind,
  //             members/{pid}: { name, color, icon } },                            // 開始時点の参加者
  //     results/{n}/{idx}/{pid}: { score, pos },
  //     chat/{key}: { pid, c, t },
  //   }
  // ======================================================================
  const Online = (() => {
    const pid = (() => {
      let id = null;
      try { id = sessionStorage.getItem("hhmm-pid"); } catch (e) {}
      if (!id) {
        id = Math.random().toString(36).slice(2, 10);
        try { sessionStorage.setItem("hhmm-pid", id); } catch (e) {}
      }
      return id;
    })();
    const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const FAST = params.get("fast") === "1"; // 動作確認用：時間を短くする
    const PLAY_MS = FAST ? 15000 : 60000;   // 1字の制限時間（お手本を見る3秒を含む）
    const RESULT_MS = FAST ? 3000 : 6000;   // 1字ごとの結果を見せる時間
    const GRACE_MS = 1500;    // 時間切れの答えが届くのを待つ余裕
    const CHAT_SHOW_MS = 8000;
    const COLORS = [
      ["朱", "#c8372d"], ["藍", "#2f56b0"], ["若竹", "#2f8a55"], ["山吹", "#c98f00"],
      ["紫", "#7d4fa8"], ["桃", "#d4588a"], ["茶", "#8a5a2b"], ["墨", "#3a3a44"],
    ];
    const isKanji = (c) => /^\p{Script=Han}$/u.test(c);
    const o = {
      be: null, code: null, room: null, unsub: null, active: false,
      tutorial: false, playingKey: null, tick: null, hostBusy: false,
      shownChat: new Set(), chatPrimed: false, meData: null, color: store.get("hhmm-color", null),
    };

    // ---------- 共通 ----------
    const now = () => (o.be ? o.be.now() : Date.now());
    const room = () => o.room || {};
    const players = () => room().players || {};
    const me = () => players()[pid];
    const game = () => room().game || { phase: "lobby", n: 0 };
    const playerIds = () => Object.keys(players()).sort((a, b) => players()[a].joinedAt - players()[b].joinedAt);
    const resultsAt = (n, idx) => (room().results && room().results[n] && room().results[n][idx]) || {};
    const memberIds = (g) => Object.keys(g.members || {});
    const charsOf = (g) => Array.from(g.chars || "");

    const isHost = () => {
      const r = room();
      if (!r.players) return false;
      if (r.host && r.players[r.host]) return r.host === pid;
      // 親が抜けたら、いちばん早く入った人が親を引き継ぐ
      return playerIds()[0] === pid;
    };
    const hostId = () => (players()[room().host] ? room().host : playerIds()[0]);

    function setHtml(el, html) {
      if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
    }

    function iconHtml(p, size) {
      const cls = "icon" + (size ? " " + size : "");
      const color = (p && p.color) || COLORS[0][1];
      const k = p && p.icon && byChar(p.icon.c);
      const inner = k
        ? arrangementSvg(k, "strokes", posList(p.icon.pos, k.strokes.length), false)
        : `<b>${esc((p && p.iconChar) || "？")}</b>`;
      return `<span class="${cls}" style="--c:${color}">${inner}</span>`;
    }

    function inviteUrl(code) {
      const u = new URL(location.href);
      u.search = "";
      u.hash = "";
      u.searchParams.set("room", code);
      if (useMock) u.searchParams.set("mock", "1");
      return u.toString();
    }

    function showError(msg) {
      const e = $("joinError");
      e.textContent = msg;
      e.hidden = !msg;
    }

    async function backend() {
      if (o.be) return o.be;
      try {
        o.be = await getBackend();
      } catch (e) {
        showError(e.message === "noconfig"
          ? "オンライン用の設定（firebase-config.js）がまだです。README の手順で設定してください。"
          : "サーバーに接続できませんでした。時間をおいて試してください。");
        throw e;
      }
      return o.be;
    }

    // ---------- 参加フォーム ----------
    function renderColorPick() {
      if (!o.color) o.color = COLORS[Math.floor(Math.random() * COLORS.length)][1];
      $("colorPick").innerHTML = COLORS.map(([name, c]) =>
        `<button type="button" role="radio" aria-checked="${c === o.color}" aria-label="${name}" title="${name}" data-c="${c}" style="--c:${c}"></button>`).join("");
    }
    $("colorPick").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      o.color = b.dataset.c;
      store.set("hhmm-color", o.color);
      renderColorPick();
    });

    /** フォームから自分の参加者データを作る。足りないものがあれば null */
    function formPlayer() {
      const name = $("nameInput").value.trim().slice(0, 12);
      if (!name) { showError("なまえを入れてください。"); $("nameInput").focus(); return null; }
      const ch = $("iconInput").value.trim();
      if (!ch) { showError("アイコンにする好きな漢字を1字入れてください。"); $("iconInput").focus(); return null; }
      if (Array.from(ch).length !== 1 || !isKanji(ch)) { showError("アイコンの字は漢字1字にしてください。"); $("iconInput").focus(); return null; }
      if (!byChar(ch)) { showError(`「${ch}」は収録されていない字です。小学校で習う漢字から選んでください。`); $("iconInput").focus(); return null; }
      store.set("hhmm-name", name);
      store.set("hhmm-iconchar", ch);
      // 同じ字のアイコンを前に作っていれば、それを使う（ロビーで作り直せる）
      const saved = store.get("hhmm-icon", null);
      const icon = saved && saved.c === ch ? saved : null;
      return { name, color: o.color, iconChar: ch, icon, joinedAt: now() };
    }

    async function create() {
      showError("");
      const p = formPlayer();
      if (!p) return;
      const be = await backend();
      p.joinedAt = be.now();
      let code = "";
      for (let i = 0; i < 5; i++) {
        code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
        if (!(await be.get(`rooms/${code}/createdAt`))) break;
      }
      await be.set(`rooms/${code}`, {
        host: pid, createdAt: be.now(),
        settings: { blind: settings.blind },
        game: { phase: "lobby", n: 0 },
        players: { [pid]: p },
      });
      o.meData = p;
      enterRoom(code);
    }

    async function join(codeRaw) {
      showError("");
      const p = formPlayer();
      if (!p) return;
      const code = (codeRaw || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) { showError("部屋のコードは4文字です。"); return; }
      const be = await backend();
      if (!(await be.get(`rooms/${code}/createdAt`))) { showError(`部屋「${code}」が見つかりません。コードを確かめてください。`); return; }
      p.joinedAt = be.now();
      await be.set(`rooms/${code}/players/${pid}`, p);
      o.meData = p;
      enterRoom(code);
    }

    function enterRoom(code) {
      o.code = code;
      o.playingKey = null;
      o.tutorial = false;
      o.chatPrimed = false;
      o.be.removeOnDisconnect(`rooms/${code}/players/${pid}`);
      const u = new URL(location.href);
      u.searchParams.set("room", code);
      history.replaceState(null, "", u);
      $("joinView").hidden = true;
      $("roomView").hidden = false;
      if (o.unsub) o.unsub();
      o.unsub = o.be.on(`rooms/${code}`, onRoom);
      clearInterval(o.tick);
      o.tick = setInterval(tick, 250);
    }

    async function leave() {
      clearInterval(o.tick);
      if (o.unsub) o.unsub();
      o.unsub = null;
      if (o.be && o.code) await o.be.remove(`rooms/${o.code}/players/${pid}`);
      o.code = null;
      o.room = null;
      $("players").innerHTML = "";
      const u = new URL(location.href);
      u.searchParams.delete("room");
      history.replaceState(null, "", u);
      showJoin();
    }

    // ---------- 部屋の変化を受け取る ----------
    function onRoom(r) {
      if (!o.active) return;
      if (!r) { showError("部屋がなくなりました。"); leave(); return; }
      o.room = r;
      // 自分が一覧から消えていたら（通信が切れた後など）入り直す
      if (!r.players || !r.players[pid]) {
        const p = { ...(o.meData || { name: "ななし", color: o.color, iconChar: "人", icon: null }), joinedAt: now() };
        o.be.set(`rooms/${o.code}/players/${pid}`, p);
        return;
      }
      o.meData = { ...r.players[pid] };
      delete o.meData.last;
      if (isHost() && r.host !== pid && !r.players[r.host]) o.be.update(`rooms/${o.code}`, { host: pid });

      if (r.settings) { settings.blind = !!r.settings.blind; showSettings(); }
      lockSettings(!isHost());

      renderStrip();
      renderChat();
      sync();
    }

    /** いまの局面に合わせて画面を切り替える */
    function sync() {
      const m = me();
      if (!m) return;
      if (!m.icon) { if (!o.tutorial) startTutorial(); return; }
      if (o.tutorial) return;
      const g = game();
      const member = !!(g.members && g.members[pid]);
      if (g.phase === "play") {
        if (!member) return showSpectate(g);
        const key = g.n + ":" + g.idx;
        // 古い局面を一瞬受け取って半紙が片付いてしまった場合も、まだ答えていなければやり直す
        const lost = o.playingKey === key && Engine.phase === "done" && !resultsAt(g.n, g.idx)[pid];
        if (o.playingKey !== key || lost) {
          o.playingKey = key;
          if (resultsAt(g.n, g.idx)[pid]) Engine.idle("みんなを待っています");
          else startChar(g);
        }
      } else if (g.phase === "result") {
        showRound(g);
      } else if (g.phase === "final") {
        showFinal(g);
      } else {
        showLobby();
      }
    }

    // ---------- アイコンづくり（チュートリアル） ----------
    function startTutorial() {
      const m = me();
      const k = byChar(m.iconChar) || byChar("人") || DATA[0];
      o.tutorial = true;
      let positions = null;
      Engine.setHooks({
        prefix: () => `アイコンづくり「${k.c}」`,
        onReveal: (res) => { positions = res.positions; },
        afterReveal: () => [
          ["このアイコンにする", "primary", async () => {
            const icon = { c: k.c, pos: positions };
            store.set("hhmm-icon", icon);
            o.tutorial = false;
            await o.be.update(`rooms/${o.code}/players/${pid}`, { icon });
          }],
          ["やり直す", "", () => { o.tutorial = false; startTutorial(); }],
        ],
      });
      setTimer("");
      Engine.start(k, { mode: "strokes", blind: true });
    }

    // ---------- ロビー ----------
    function showLobby() {
      const host = isHost();
      Engine.setHooks({});
      if (Engine.phase !== "done") Engine.hideStage();
      const m = me();
      const ready = playerIds().filter((id) => players()[id].icon).length;
      setHtml($("onlinePanel"), `
        <div class="lobby">
          <h2>ロビー</h2>
          <div class="roomcode"><span class="notice">部屋</span><b>${esc(o.code)}</b></div>
          <div class="invite"><code>${esc(inviteUrl(o.code))}</code><button type="button" class="btn small" data-act="copy">コピー</button></div>
          <p class="notice">アイコンにカーソルを合わせる（スマホはタップ）と、その人の前回の四字熟語が見られます。上の入力欄から、いつでも漢字1字でチャットできます。</p>
          <div class="remake">
            ${iconHtml(m, "")}
            <input id="remakeInput" maxlength="2" placeholder="字" value="${esc(m.iconChar || "")}" style="width:3.2em;font-size:18px;padding:6px 8px;border-radius:8px;background:var(--kon-deep);color:var(--hanshi);border:1px solid var(--kon-line);font-family:var(--font-display)" aria-label="アイコンの字">
            <button type="button" class="btn small" data-act="remake">アイコンを作り直す</button>
          </div>
          <div class="colors" data-role="lobbyColors">${COLORS.map(([name, c]) =>
            `<button type="button" role="radio" aria-checked="${c === m.color}" aria-label="${name}" title="${name}" data-c="${c}" style="--c:${c}"></button>`).join("")}</div>
          <p class="notice err" data-role="lobbyErr" hidden></p>
        </div>`);
      $("onlinePanel").hidden = false;
      setStatus(host ? `ロビー　${playerIds().length}人` : "親がはじめるのを待っています");
      setTimer("");
      if (host) setActionsOnce("lobby:" + ready, [["はじめる", "primary", startGame, ready === 0]]);
      else setActionsOnce("lobby-guest", []);
    }

    $("onlinePanel").addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.act === "copy") {
        const code = b.parentElement.querySelector("code");
        try { await navigator.clipboard.writeText(code.textContent); b.textContent = "コピーしました"; }
        catch (err) { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        setTimeout(() => (b.textContent = "コピー"), 1500);
      } else if (b.dataset.act === "remake") {
        const ch = ($("remakeInput").value || "").trim();
        const err = $("onlinePanel").querySelector('[data-role="lobbyErr"]');
        const bad = Array.from(ch).length !== 1 || !isKanji(ch) ? "漢字1字にしてください。" : !byChar(ch) ? `「${ch}」は収録されていない字です。` : "";
        err.textContent = bad;
        err.hidden = !bad;
        if (bad) return;
        store.set("hhmm-iconchar", ch);
        await o.be.update(`rooms/${o.code}/players/${pid}`, { iconChar: ch, icon: null });
      } else if (b.closest('[data-role="lobbyColors"]')) {
        o.color = b.dataset.c;
        store.set("hhmm-color", o.color);
        await o.be.update(`rooms/${o.code}/players/${pid}`, { color: o.color });
      }
    });

    async function startGame() {
      if (!isHost()) return;
      const g = game();
      const n = (g.n || 0) + 1;
      const members = {};
      playerIds().forEach((id) => {
        const p = players()[id];
        if (p.icon) members[id] = { name: p.name, color: p.color, icon: p.icon };
      });
      if (!Object.keys(members).length) return;
      await o.be.update(`rooms/${o.code}`, {
        game: {
          n, phase: "play", idx: 0, chars: randomChars().join(""),
          deadline: now() + PLAY_MS, blind: settings.blind, members,
        },
        [`results/${n - 1}`]: null,
      });
    }

    // ---------- 1字に挑戦 ----------
    function startChar(g) {
      const k = byChar(charsOf(g)[g.idx]);
      if (!k) return;
      Engine.setHooks({
        prefix: () => `${g.idx + 1}字目 / ${SET_SIZE}`,
        onReveal: ({ score, positions }) => {
          o.be.set(`rooms/${o.code}/results/${g.n}/${g.idx}/${pid}`, { score, pos: positions });
        },
        afterReveal: () => [],
      });
      Engine.start(k, { mode: "strokes", blind: !!g.blind });
    }

    function showSpectate(g) {
      const key = "spectate:" + g.n + ":" + g.idx;
      if (o.playingKey !== key) {
        o.playingKey = key;
        Engine.setHooks({});
        Engine.idle("観戦中です。<br>次のゲームから参加できます");
      }
      setStatus(`${g.idx + 1}字目 / ${SET_SIZE}　観戦中`);
    }

    // ---------- 1字ごとの結果 ----------
    /** 参加者ごとの点数表（idx までの字） */
    function standings(g, uptoIdx) {
      const chars = charsOf(g);
      return memberIds(g).map((id) => {
        const mb = g.members[id];
        const p = players()[id] || mb;
        const items = chars.slice(0, uptoIdx + 1).map((c, i) => {
          const r = resultsAt(g.n, i)[id];
          return { c, score: r ? r.score : 0, pos: r ? r.pos : null, done: !!r };
        });
        return { id, name: p.name || mb.name, color: p.color || mb.color, icon: p.icon || mb.icon, items, total: totalOf(items) };
      });
    }

    function lineGraph(rows, steps) {
      const W = 340, H = 170, L = 34, R = 14, T = 10, B = 24, MAX = SET_SIZE * 100;
      const x = (i) => L + (i * (W - L - R)) / SET_SIZE;
      const y = (v) => T + (1 - v / MAX) * (H - T - B);
      let g = "";
      for (let v = 0; v <= MAX; v += 100) {
        g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
      }
      for (let i = 1; i <= SET_SIZE; i++) g += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${i}字目</text>`;
      rows.forEach((r) => {
        let acc = 0;
        const pts = [[x(0), y(0)]];
        r.items.slice(0, steps).forEach((it, i) => { acc += it.score; pts.push([x(i + 1), y(acc)]); });
        g += `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${r.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
        pts.slice(1).forEach(([px, py]) => { g += `<circle cx="${px}" cy="${py}" r="3.2" fill="${r.color}"/>`; });
      });
      return `<svg viewBox="0 0 ${W} ${H}" xmlns="${NS}" role="img" aria-label="合計点の推移">${g}</svg>`;
    }

    function showRound(g) {
      if (Engine.phase !== "done") Engine.hideStage();
      Engine.setHooks({});
      const k = byChar(charsOf(g)[g.idx]);
      const rows = standings(g, g.idx);
      const sorted = [...rows].sort((a, b) => b.items[g.idx].score - a.items[g.idx].score);
      const best = sorted.length ? sorted[0].items[g.idx].score : 0;
      setHtml($("onlinePanel"), `
        <div class="final">
          <div class="round-head"><span>${g.idx + 1}字目の結果</span><b>「${esc(k ? k.c : "")}」</b></div>
          <div class="round-grid">
            ${sorted.map((r) => {
              const it = r.items[g.idx];
              const placedAny = it.done && k && posList(it.pos, k.strokes.length).some(validPos);
              const svg = placedAny ? arrangementSvg(k, "strokes", posList(it.pos, k.strokes.length), false) : `<span class="timeout">時間切れ</span>`;
              return `<figure class="card ${it.score === best && best > 0 ? "top" : ""}"><div class="sq">${svg}</div>
                <figcaption>${iconHtml(r, "sm")}<span class="who">${esc(r.name)}${r.id === pid ? "（あなた）" : ""}</span><b>${it.score}</b></figcaption></figure>`;
            }).join("")}
          </div>
          <div class="graph">${lineGraph(rows, g.idx + 1)}</div>
        </div>`);
      $("onlinePanel").hidden = false;
      setStatus(`${g.idx + 1}字目の結果`);
      setActionsOnce("round", []);
    }

    // ---------- 結果発表 ----------
    function showFinal(g) {
      if (Engine.phase !== "done") Engine.hideStage();
      Engine.setHooks({});
      const rows = standings(g, SET_SIZE - 1).sort((a, b) => b.total - a.total);
      rows.forEach((r, i) => { r.rank = i > 0 && r.total === rows[i - 1].total ? rows[i - 1].rank : i + 1; });
      const win = rows[0];
      const sheetItems = (r) => r.items.map((it) => ({ c: it.c, score: it.score, pos: it.pos, mode: "strokes" }));
      setHtml($("onlinePanel"), win ? `
        <div class="final">
          <h2>結果発表</h2>
          <div class="winner">
            ${yojiSheet(sheetItems(win), "big")}
            <div class="winner-side">
              <div class="yoji-label">優勝</div>
              ${iconHtml(win, "lg")}
              <div class="winner-name">${esc(win.name)}${win.id === pid ? "（あなた）" : ""}</div>
              <div class="yoji-orig">${win.items.map((it) => esc(it.c)).join("")}</div>
              <div class="yoji-total"><b>${win.total}</b><span>/ ${SET_SIZE * 100}点</span></div>
            </div>
          </div>
          <ol class="ranking">
            ${rows.map((r) => `<li><span class="rk">${r.rank}位</span>${iconHtml(r, "sm")}
              <span class="nm">${esc(r.name)}${r.id === pid ? "（あなた）" : ""}<small>${r.items.map((it) => `${esc(it.c)} ${it.score}`).join("・")}</small></span>
              <span class="tt">${r.total}点</span></li>`).join("")}
          </ol>
          <div class="graph">${lineGraph(rows, SET_SIZE)}</div>
          ${rows.length > 1 ? `<h2>みんなの四字熟語</h2><div class="gallery">${rows.map((r) => `
            <figure class="${r.rank === 1 ? "top" : ""}">${yojiSheet(sheetItems(r), "small")}
              <figcaption><span class="who">${esc(r.name)}</span><span class="pt">${r.total}点・${r.rank}位</span></figcaption></figure>`).join("")}</div>` : ""}
        </div>` : "");
      $("onlinePanel").hidden = false;
      setStatus("結果発表");
      setTimer("");
      if (isHost()) setActionsOnce("final-host", [["ロビーへ戻る", "primary", () => o.be.update(`rooms/${o.code}/game`, { phase: "lobby" })]]);
      else { setActionsOnce("final-guest", []); setStatus("結果発表　親がロビーへ戻すのを待っています"); }
    }

    // ---------- 進行（250ms ごと） ----------
    function tick() {
      if (!o.active || !o.room) return;
      const g = game();
      const t = now();
      if (!o.tutorial && me() && me().icon) {
        if (g.phase === "play") {
          const remain = Math.max(0, Math.ceil((g.deadline - t) / 1000));
          const present = memberIds(g).filter((id) => players()[id]);
          const done = present.filter((id) => resultsAt(g.n, g.idx)[id]).length;
          const mine = !!resultsAt(g.n, g.idx)[pid] || Engine.phase === "reveal";
          setTimer(mine ? `${done} / ${present.length}人完了・残り${remain}秒` : `残り${remain}秒`, remain <= 10 && !mine);
          // 時間切れ：そのときの配置のまま答え合わせ
          if (remain <= 0 && o.playingKey === g.n + ":" + g.idx && (Engine.phase === "preview" || Engine.phase === "play")) Engine.forceReveal();
        } else if (g.phase === "result") {
          const remain = Math.max(0, Math.ceil((g.resultUntil - t) / 1000));
          setTimer(g.idx < SET_SIZE - 1 ? `次の字まで ${remain}秒` : `結果発表まで ${remain}秒`);
        }
      }
      if (isHost()) hostStep(g, t);
    }

    async function hostStep(g, t) {
      if (o.hostBusy) return;
      let patch = null;
      if (g.phase === "play") {
        const present = memberIds(g).filter((id) => players()[id]);
        const res = resultsAt(g.n, g.idx);
        if (present.every((id) => res[id]) || t > g.deadline + GRACE_MS) {
          patch = { "game/phase": "result", "game/resultUntil": t + RESULT_MS };
        }
      } else if (g.phase === "result" && t > g.resultUntil) {
        if (g.idx < SET_SIZE - 1) {
          patch = { "game/phase": "play", "game/idx": g.idx + 1, "game/deadline": t + PLAY_MS };
        } else {
          patch = { "game/phase": "final" };
          // 前回の成績として、各参加者に保存（ロビーで見られる）
          const rows = standings(g, SET_SIZE - 1).sort((a, b) => b.total - a.total);
          rows.forEach((r, i) => {
            const rank = i > 0 && r.total === rows[i - 1].total ? rows[i - 1].rank : i + 1;
            r.rank = rank;
            if (players()[r.id]) {
              patch[`players/${r.id}/last`] = {
                total: r.total, rank, of: rows.length,
                items: r.items.map((it) => ({ c: it.c, score: it.score, pos: it.pos || [UNPLACED] })),
              };
            }
          });
        }
      }
      if (!patch) return;
      o.hostBusy = true;
      try { await o.be.update(`rooms/${o.code}`, patch); } finally { o.hostBusy = false; }
    }

    // ---------- 参加者アイコン列 ----------
    function subText(id, p) {
      if (!p.icon) return "アイコン作成中";
      const g = game();
      const member = g.members && g.members[id];
      if (g.phase === "play") {
        if (!member) return "観戦";
        return resultsAt(g.n, g.idx)[id] ? "✓ できた" : "考え中";
      }
      if (g.phase === "result") {
        const r = member && resultsAt(g.n, g.idx)[id];
        return member ? `${r ? r.score : 0}点` : "観戦";
      }
      if (g.phase === "final") {
        if (!member) return "観戦";
        return `${standings(g, SET_SIZE - 1).find((r) => r.id === id).total}点`;
      }
      return p.last ? `前回 ${p.last.total}点` : "はじめて";
    }

    function renderStrip() {
      const box = $("players");
      const ids = playerIds();
      const hid = hostId();
      // 消えた人を取り除く
      box.querySelectorAll(".pl").forEach((el) => { if (!players()[el.dataset.pid]) el.remove(); });
      ids.forEach((id, i) => {
        const p = players()[id];
        let el = box.querySelector(`.pl[data-pid="${id}"]`);
        if (!el) {
          el = document.createElement("div");
          el.className = "pl";
          el.dataset.pid = id;
          el.tabIndex = 0;
          el.innerHTML = `<div class="bubbles"></div><div class="pl-icon"></div><div class="pl-name"></div><div class="pl-sub"></div><div class="pop" hidden></div>`;
          el.addEventListener("mouseenter", () => fitPop(el));
          el.addEventListener("focus", () => fitPop(el));
        }
        if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
        el.classList.toggle("me", id === pid);
        el.classList.toggle("host", id === hid);
        el.style.setProperty("--c", p.color || COLORS[0][1]);
        setHtml(el.querySelector(".pl-icon"), iconHtml(p, ""));
        setHtml(el.querySelector(".pl-name"), esc(p.name) + (id === pid ? "" : ""));
        setHtml(el.querySelector(".pl-sub"), esc(subText(id, p)));
        const pop = el.querySelector(".pop");
        if (p.last && p.last.items) {
          setHtml(pop, `${yojiSheet(toArr(p.last.items).map((it) => ({ ...it, mode: "strokes" })), "small")}前回 ${p.last.total}点・${p.last.rank}位`);
          pop.hidden = false;
        } else {
          setHtml(pop, "");
          pop.hidden = true;
        }
      });
    }

    /** 前回の四字熟語のポップアップが画面からはみ出さないよう左右にずらす */
    function fitPop(el) {
      const pop = el.querySelector(".pop");
      if (pop.hidden) return;
      pop.style.transform = "translateX(-50%)";
      const r = pop.getBoundingClientRect();
      const margin = 8;
      let shift = 0;
      if (r.left < margin) shift = margin - r.left;
      else if (r.right > window.innerWidth - margin) shift = window.innerWidth - margin - r.right;
      pop.style.transform = `translateX(calc(-50% + ${shift}px))`;
    }

    // ---------- 漢字1字チャット ----------
    async function sendChat() {
      const input = $("chatInput");
      const c = input.value.trim();
      const err = $("chatError");
      const bad = !c ? "" : Array.from(c).length !== 1 || !isKanji(c) ? "漢字1字だけ送れます" : "";
      err.textContent = bad;
      err.hidden = !bad;
      if (!c || bad || !o.code) return;
      input.value = "";
      const t = Math.round(now());
      const patch = { [`chat/${t}_${pid}`]: { pid, c, t } };
      // 自分の古い発言は消して、部屋のデータを軽く保つ
      Object.entries(room().chat || {}).forEach(([key, m]) => { if (m.pid === pid && t - m.t > 30000) patch[`chat/${key}`] = null; });
      await o.be.update(`rooms/${o.code}`, patch);
    }

    function renderChat() {
      const t = now();
      Object.entries(room().chat || {}).forEach(([key, m]) => {
        if (o.shownChat.has(key) || !m || !m.c || !m.t) return;
        o.shownChat.add(key);
        // 入室前の古い発言は出さない
        if (!o.chatPrimed && t - m.t > 3000) return;
        if (t - m.t > CHAT_SHOW_MS) return;
        const el = $("players").querySelector(`.pl[data-pid="${m.pid}"] .bubbles`);
        if (!el) return;
        const p = players()[m.pid] || {};
        const b = document.createElement("span");
        b.className = "bubble";
        b.style.setProperty("--c", p.color || COLORS[0][1]);
        b.textContent = m.c;
        el.appendChild(b);
        setTimeout(() => b.remove(), 4600);
      });
      o.chatPrimed = true;
    }

    $("chatSend").addEventListener("click", () => sendChat());
    $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) sendChat(); });

    // ---------- 表示の小物 ----------
    function setStatus(text) { $("status").textContent = text; }
    function setTimer(text, hurry) {
      const el = $("timer");
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle("hurry", !!hurry);
    }
    /** 同じボタン構成なら作り直さない（押している途中に消えないように） */
    function setActionsOnce(key, list) {
      if ($("actions").dataset.key === key) return;
      setActions(list);
      $("actions").dataset.key = key;
    }

    // ---------- あそびかたの切り替え ----------
    function enter() {
      o.active = true;
      SetPlay.stop();
      o.playingKey = null;
      $("soloPanel").hidden = true;
      onSettingsChange = () => {
        if (o.code && isHost()) o.be.update(`rooms/${o.code}`, { settings: { blind: settings.blind } });
      };
      if (o.code && o.room) {
        $("joinView").hidden = true;
        $("roomView").hidden = false;
        onRoom(o.room);
      } else showJoin();
    }

    function showJoin() {
      $("joinView").hidden = false;
      $("roomView").hidden = true;
      lockSettings(false);
      renderColorPick();
      Engine.setHooks({});
      Engine.idle("部屋を作るか、<br>コードを入れて部屋に入ってください");
      setTimer("");
      setActions([]);
      if (!onlineAvailable) {
        showError("オンライン用の設定（firebase-config.js）がまだです。README の手順で設定してください。");
      }
    }

    function exit() {
      o.active = false;
      setTimer("");
      $("joinView").hidden = true;
      $("roomView").hidden = true;
      $("onlinePanel").hidden = true;
      $("soloPanel").hidden = false;
    }

    $("nameInput").value = store.get("hhmm-name", "");
    $("iconInput").value = store.get("hhmm-iconchar", "");
    $("createBtn").addEventListener("click", () => create().catch(() => {}));
    $("joinBtn").addEventListener("click", () => join($("codeInput").value).catch(() => {}));
    $("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });
    $("leaveBtn").addEventListener("click", () => leave());

    return { enter, exit, join };
  })();

  // ======================================================================
  // あそびかたの切り替え
  // ======================================================================
  function switchTo(mode) {
    $("playTabs").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === mode)));
    if (mode === "online") Online.enter();
    else { Online.exit(); Solo.enter(); }
  }
  $("playTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) switchTo(b.dataset.v);
  });

  showSettings();
  const roomParam = params.get("room");
  if (roomParam) {
    switchTo("online");
    $("codeInput").value = roomParam.toUpperCase();
    // なまえとアイコンの字が保存済みなら、招待リンクからそのまま入る
    if ($("nameInput").value.trim() && $("iconInput").value.trim()) Online.join(roomParam).catch(() => {});
    else ($("nameInput").value.trim() ? $("iconInput") : $("nameInput")).focus();
  } else {
    switchTo("solo");
  }
})();
