// へのへのもじもじ — 漢字福笑い
// 1. Engine  : 半紙とパーツの描画、ドラッグ、採点（ひとりでも、みんなでも共通）
// 2. Backend : 部屋のデータを置く場所（Firebase Realtime Database。?mock=1 のときは同じブラウザ内の疑似サーバー）
// 3. SetPlay : 4字で1セットの進行と、四字熟語の結果表示
// 4. Solo / Online : あそびかたごとの進行
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

  /** パーツを描いた墨のマスク（1 = 墨）と重心を返す。offset は全体をずらす量（KanjiVG単位） */
  function inkMask(kanji, groups, positions, offset) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = SIL.px;
    const g = cv.getContext("2d");
    g.lineWidth = SIL.stroke;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "#000";
    groups.forEach((idx, i) => {
      g.setTransform(SIL_SCALE, 0, 0, SIL_SCALE, (SIL.margin + offset[0]) * SIL_SCALE, (SIL.margin + offset[1]) * SIL_SCALE);
      if (positions) {
        const bb = measure(kanji, idx);
        g.translate(positions[i][0] - bb.x, positions[i][1] - bb.y);
      }
      idx.forEach((s) => g.stroke(new Path2D(kanji.strokes[s])));
    });
    const px = g.getImageData(0, 0, SIL.px, SIL.px).data;
    const mask = new Uint8Array(SIL.px * SIL.px);
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < mask.length; i++) {
      if (px[i * 4 + 3] > 96) {
        mask[i] = 1;
        n++;
        sx += i % SIL.px;
        sy += Math.floor(i / SIL.px);
      }
    }
    return { mask, n, cx: n ? sx / n : 0, cy: n ? sy / n : 0 };
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
    if (!modelCache.has(key)) {
      const whole = inkMask(kanji, [allIdx(kanji)], null, [0, 0]);
      modelCache.set(key, {
        whole, dmap: distanceMap(whole.mask),
        pieces: groups.map((idx) => inkMask(kanji, [idx], null, [0, 0]).mask),
      });
    }
    const model = modelCache.get(key);
    const first = inkMask(kanji, groups, positions, [0, 0]);
    const shift = [(model.whole.cx - first.cx) / SIL_SCALE, (model.whole.cy - first.cy) / SIL_SCALE];
    const mine = inkMask(kanji, groups, positions, shift);
    const mineD = distanceMap(mine.mask);
    // パーツごとに距離を測って平均する（小さいパーツも大きいパーツと同じ重さ）
    //  ・自分の各パーツ → お手本の墨：余計なところに置いたパーツを減点
    //  ・お手本の各パーツ → 自分の墨：あるべき場所に墨がないのを減点
    // どちらも「どのパーツか」は問わず墨全体と比べるので、同じ形の部品の入れ替えは減点されない
    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const extra = avg(groups.map((idx, i) => meanDist(inkMask(kanji, [idx], [positions[i]], shift).mask, model.dmap)));
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
      const [x, y] = positions[i] || [bb.x, bb.y];
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
      $("yojiPanel").hidden = true;
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
      st.phase = "reveal";
      const cover = board.querySelector(".cover");
      st.pieces.forEach((p) => {
        p.el.classList.add("reveal");
        p.el.classList.remove("hiddenplace");
      });
      if (cover) requestAnimationFrame(() => cover.classList.add("off"));
      const positions = st.pieces.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
      const score = scoreArrangement(st.kanji, st.mode, positions);
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
    return { start, idle, hideStage, setHooks, refreshActions, get phase() { return st.phase; }, get kanji() { return st.kanji; } };
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
    return {
      get: async (p) => (await db.get(r(p))).val(),
      set: (p, v) => db.set(r(p), v),
      update: (p, v) => db.update(r(p), v),
      remove: (p) => db.remove(r(p)),
      on: (p, cb) => db.onValue(r(p), (s) => cb(s.val())),
      removeOnDisconnect: (p) => db.onDisconnect(r(p)).remove(),
    };
  }

  // 動作確認用：同じブラウザのタブ同士で部屋を共有する疑似サーバー（?mock=1）
  function mockBackend() {
    const KEY = "hhmm-mockdb";
    const subs = new Set();
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } };
    const at = (d, p) => { const v = p.split("/").reduce((o, k) => (o == null ? null : o[k]), d); return v === undefined ? null : v; };
    const put = (d, p, v) => {
      const ks = p.split("/");
      let o = d;
      ks.slice(0, -1).forEach((k) => { if (typeof o[k] !== "object" || o[k] === null) o[k] = {}; o = o[k]; });
      if (v === null) delete o[ks[ks.length - 1]];
      else o[ks[ks.length - 1]] = JSON.parse(JSON.stringify(v));
    };
    const emit = () => { const d = load(); subs.forEach((s) => s.cb(at(d, s.p))); };
    const save = (d) => { localStorage.setItem(KEY, JSON.stringify(d)); setTimeout(emit, 0); };
    window.addEventListener("storage", (e) => { if (e.key === KEY) emit(); });
    return {
      get: async (p) => at(load(), p),
      set: async (p, v) => { const d = load(); put(d, p, v); save(d); },
      update: async (p, obj) => { const d = load(); Object.keys(obj).forEach((k) => put(d, p + "/" + k, obj[k])); save(d); },
      remove: async (p) => { const d = load(); put(d, p, null); save(d); },
      on: (p, cb) => { const s = { p, cb }; subs.add(s); setTimeout(() => cb(at(load(), p)), 0); return () => subs.delete(s); },
      removeOnDisconnect: () => {},
    };
  }

  const params = new URLSearchParams(location.search);
  if (params.get("debug") === "1") window.HHMM = { DATA, groupsFor, measure, scoreArrangement, SIL };
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
  const FIRST_KANJI = "顔";

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
      return `<div class="cell">${k ? arrangementSvg(k, it.mode, toArr(it.pos), false) : ""}</div>`;
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
    let firstSet = true;
    function newSet() {
      const chars = randomChars(firstSet ? FIRST_KANJI : null);
      firstSet = false;
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
  // 4b. Online（同じ4字を全員が各自のペースで解き、四字熟語を見せ合う）
  //   rooms/{CODE} = {
  //     host, createdAt,
  //     settings: { mode, blind },                       // 親が次のセットのために選んでいる設定
  //     round: { n, chars: "顔晶森愛", mode, blind },     // n = 0 は待合室
  //     players/{pid}: { name, joinedAt },
  //     results/{n}/{pid}: { name, items: [{ c, score, pos, mode }], total, done }
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
    const o = { be: null, code: null, room: null, unsub: null, startedRound: 0, active: false };

    const isHost = () => {
      const r = o.room;
      if (!r || !r.players) return false;
      if (r.host && r.players[r.host]) return r.host === pid;
      // 親が抜けたら、いちばん早く入った人が親を引き継ぐ
      const first = Object.entries(r.players).sort((a, b) => a[1].joinedAt - b[1].joinedAt)[0];
      return first && first[0] === pid;
    };

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

    function myName() {
      const n = $("nameInput").value.trim().slice(0, 12);
      if (!n) { showError("なまえを入れてください。"); $("nameInput").focus(); return null; }
      store.set("hhmm-name", n);
      return n;
    }
    const nameInRoom = () => (o.room && o.room.players && o.room.players[pid] && o.room.players[pid].name) || store.get("hhmm-name", "") || "ななし";

    async function create() {
      showError("");
      const name = myName();
      if (!name) return;
      const be = await backend();
      let code = "";
      for (let i = 0; i < 5; i++) {
        code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
        if (!(await be.get(`rooms/${code}/createdAt`))) break;
      }
      await be.set(`rooms/${code}`, {
        host: pid,
        createdAt: Date.now(),
        settings: { mode: settings.mode, blind: settings.blind },
        round: { n: 0 },
        players: { [pid]: { name, joinedAt: Date.now() } },
      });
      enterRoom(code);
    }

    async function join(codeRaw) {
      showError("");
      const name = myName();
      if (!name) return;
      const code = (codeRaw || "").trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) { showError("部屋のコードは4文字です。"); return; }
      const be = await backend();
      if (!(await be.get(`rooms/${code}/createdAt`))) { showError(`部屋「${code}」が見つかりません。コードを確かめてください。`); return; }
      await be.set(`rooms/${code}/players/${pid}`, { name, joinedAt: Date.now() });
      enterRoom(code);
    }

    function enterRoom(code) {
      o.code = code;
      o.startedRound = 0;
      o.be.removeOnDisconnect(`rooms/${code}/players/${pid}`);
      const u = new URL(location.href);
      u.searchParams.set("room", code);
      history.replaceState(null, "", u);
      $("joinView").hidden = true;
      $("roomView").hidden = false;
      $("roomCode").textContent = code;
      $("inviteUrl").textContent = inviteUrl(code);
      if (o.unsub) o.unsub();
      o.unsub = o.be.on(`rooms/${code}`, onRoom);
    }

    async function leave() {
      if (o.unsub) o.unsub();
      o.unsub = null;
      if (o.be && o.code) await o.be.remove(`rooms/${o.code}/players/${pid}`);
      o.code = null;
      o.room = null;
      SetPlay.stop();
      const u = new URL(location.href);
      u.searchParams.delete("room");
      history.replaceState(null, "", u);
      showJoin();
    }

    function onRoom(room) {
      if (!o.active) return;
      if (!room) { showError("部屋がなくなりました。"); leave(); return; }
      o.room = room;
      // 自分が一覧から消えていたら（通信が切れた後など）入り直す
      if (!room.players || !room.players[pid]) {
        o.be.set(`rooms/${o.code}/players/${pid}`, { name: nameInRoom(), joinedAt: Date.now() });
        return;
      }
      const host = isHost();
      if (host && room.host !== pid && !room.players[room.host]) o.be.update(`rooms/${o.code}`, { host: pid });

      // 設定：親だけが変えられる（次のセットから反映）
      if (room.settings) {
        settings.blind = !!room.settings.blind;
        showSettings();
      }
      lockSettings(!host);

      const round = room.round || { n: 0 };
      const results = (room.results && room.results[round.n]) || {};
      renderPlayers(room, round, results);

      if (round.n > 0 && round.n !== o.startedRound) {
        o.startedRound = round.n;
        const chars = Array.from(round.chars || "");
        SetPlay.begin(chars, { mode: round.mode, blind: !!round.blind }, {
          onItem: (i, item) => {
            o.be.update(`rooms/${o.code}/results/${round.n}/${pid}`, { name: nameInRoom(), [`items/${i}`]: item });
          },
          onDone: (items, total) => {
            o.be.update(`rooms/${o.code}/results/${round.n}/${pid}`, { name: nameInRoom(), total, done: true });
          },
          finalActions: () => (isHost() ? [["次のセット", "primary", nextRound]] : []),
        });
      } else if (round.n === 0) {
        Engine.idle(waitingText(host));
        setActions(host ? [["はじめる", "primary", nextRound]] : []);
      } else {
        SetPlay.refreshActions();
      }
      renderGallery(round, results);
    }

    function waitingText(host) {
      return host
        ? "みんなが集まったら<br>「はじめる」を押してください"
        : "親（部屋を作った人）が<br>はじめるのを待っています";
    }

    function renderPlayers(room, round, results) {
      const box = $("players");
      const list = Object.entries(room.players || {}).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
      const hostId = room.players[room.host] ? room.host : (list[0] && list[0][0]);
      box.innerHTML = list.map(([id, p]) => {
        const r = results[id];
        const done = r && r.done;
        const prog = round.n > 0 && r && !done ? ` ${toArr(r.items).length}/${SET_SIZE}` : "";
        const cls = [id === pid ? "me" : "", done ? "done" : "", id === hostId ? "host" : ""].join(" ");
        return `<span class="${cls}">${esc(p.name)}${prog}</span>`;
      }).join("");
      if (round.n > 0 && SetPlay.finished) {
        const doneN = list.filter(([id]) => results[id] && results[id].done).length;
        $("status").textContent = `${doneN} / ${list.length} 人の四字熟語が完成`;
      }
    }

    function renderGallery(round, results) {
      const panel = $("galleryPanel");
      const entries = Object.entries(results).filter(([, r]) => r.done);
      // 自分の四字熟語ができるまでは、他の人の作品は見せない
      if (!round.n || !results[pid] || !results[pid].done || !entries.length) { panel.hidden = true; return; }
      entries.sort((a, b) => (b[1].total || 0) - (a[1].total || 0));
      const best = entries[0][1].total;
      $("gallery").innerHTML = entries.map(([id, r]) => `
        <figure class="${r.total === best ? "top" : ""}">
          ${yojiSheet(toArr(r.items), "small")}
          <figcaption><span class="who">${esc(r.name)}${id === pid ? "（あなた）" : ""}</span><span class="pt">${r.total}点・${esc(yojiRank(r.total)[0])}</span></figcaption>
        </figure>`).join("");
      panel.hidden = false;
    }

    async function nextRound() {
      const r = o.room;
      if (!r || !isHost()) return;
      const n = ((r.round && r.round.n) || 0) + 1;
      const chars = randomChars(n === 1 ? FIRST_KANJI : null);
      await o.be.update(`rooms/${o.code}`, {
        round: { n, chars: chars.join(""), mode: settings.mode, blind: settings.blind },
        // 古い結果は消して部屋を軽く保つ
        [`results/${n - 2}`]: null,
      });
    }

    function enter() {
      o.active = true;
      SetPlay.stop();
      o.startedRound = 0;
      $("joinView").hidden = !!o.code;
      $("roomView").hidden = !o.code;
      $("soloPanel").hidden = true;
      onSettingsChange = () => {
        if (o.code && isHost()) o.be.update(`rooms/${o.code}`, { settings: { mode: settings.mode, blind: settings.blind } });
      };
      if (o.code && o.room) onRoom(o.room);
      else showJoin();
    }

    function showJoin() {
      $("joinView").hidden = false;
      $("roomView").hidden = true;
      $("galleryPanel").hidden = true;
      lockSettings(false);
      Engine.idle("部屋を作るか、<br>コードを入れて部屋に入ってください");
      setActions([]);
      if (!onlineAvailable) {
        showError("オンライン用の設定（firebase-config.js）がまだです。README の手順で設定してください。");
      }
    }

    function exit() {
      o.active = false;
      SetPlay.stop();
      $("joinView").hidden = true;
      $("roomView").hidden = true;
      $("galleryPanel").hidden = true;
      $("soloPanel").hidden = false;
    }

    $("nameInput").value = store.get("hhmm-name", "");
    $("createBtn").addEventListener("click", () => create().catch(() => {}));
    $("joinBtn").addEventListener("click", () => join($("codeInput").value).catch(() => {}));
    $("codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });
    $("leaveBtn").addEventListener("click", () => leave());
    $("copyBtn").addEventListener("click", async () => {
      const text = $("inviteUrl").textContent;
      try {
        await navigator.clipboard.writeText(text);
        $("copyBtn").textContent = "コピーしました";
      } catch (e) {
        const range = document.createRange();
        range.selectNodeContents($("inviteUrl"));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      setTimeout(() => ($("copyBtn").textContent = "コピー"), 1500);
    });

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
    // なまえが保存済みなら、招待リンクからそのまま入る
    if ($("nameInput").value.trim()) Online.join(roomParam).catch(() => {});
    else $("nameInput").focus();
  } else {
    switchTo("solo");
  }
})();
