// へのへのもじもじ — 漢字福笑い
// 1. Engine  : 半紙とパーツの描画、ドラッグ、採点（ひとりでも、みんなでも共通）
// 2. Backend : 部屋のデータを置く場所（Firebase Realtime Database。?mock=1 のときは同じブラウザ内の疑似サーバー）
// 3. Solo / Online : あそびかたごとの進行
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

  function scoreOf(positions, bbs) {
    const d = positions.reduce((s, [x, y], i) => s + Math.hypot(x - bbs[i].x, y - bbs[i].y), 0) / positions.length;
    return Math.round(100 * Math.max(0, 1 - d / 28));
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
    const st = { kanji: null, mode: "parts", blind: true, pieces: [], phase: "idle", ghost: null };
    let hooks = {};
    let L = {};
    let timer = null;
    let zTop = 1;

    function layout() {
      const W = stage.clientWidth;
      const S = Math.min(W, 380);
      const u = S / VB, gap = 14, trayH = Math.round(S * 0.85);
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

    const boardSvg = (inner, cls = "") => `<svg class="big ${cls}" viewBox="0 0 ${VB} ${VB}" xmlns="${NS}">${inner}</svg>`;

    function status() {
      const total = st.pieces.length;
      const placed = st.pieces.filter((p) => p.placed).length;
      const el = $("status");
      if (st.phase === "preview") el.textContent = "よく見て覚えてください";
      else if (st.phase === "play") el.textContent = `${placed} / ${total} パーツ`;
      else if (st.phase === "reveal") el.textContent = "答え合わせ";
      else el.textContent = "";
      if (st.phase === "play") {
        const list = [[st.blind ? "目隠しをとる" : "答え合わせ", "primary", reveal, placed < total]];
        if (hooks.skip) list.push(["やめて別の字", "", hooks.skip]);
        setActions(list);
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
      const score = scoreOf(positions, st.pieces.map((p) => p.bb));
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
      setActions([ghostBtn, ...(hooks.afterReveal ? hooks.afterReveal() : [])]);
      hooks.onReveal && hooks.onReveal({ kanji: st.kanji, score, rank: rank[0], positions });
    }

    /** お題が出ていない状態（待ち） */
    function idle(message) {
      clearInterval(timer);
      clearPieces();
      st.phase = "idle";
      st.kanji = null;
      $("result").hidden = true;
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
    return { start, idle, setHooks, refreshActions, get phase() { return st.phase; }, get kanji() { return st.kanji; } };
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
  const settings = { mode: "parts", blind: true };
  let onSettingsChange = () => {};
  function setSegValue(segId, value) {
    $(segId).querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === value)));
  }
  function showSettings() {
    setSegValue("modeSeg", settings.mode);
    setSegValue("blindSeg", settings.blind ? "on" : "off");
  }
  function lockSettings(locked) {
    document.querySelectorAll("#modeSeg button, #blindSeg button").forEach((b) => (b.disabled = locked));
  }
  $("modeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    settings.mode = b.dataset.v;
    showSettings();
    onSettingsChange();
  });
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
  // 3a. Solo
  // ======================================================================
  const Solo = (() => {
    const cleared = new Set(store.get("hhmm-cleared", []));
    function pickNext(current) {
      const rest = DATA.filter((k) => k !== current && !cleared.has(k.c));
      const pool = rest.length ? rest : DATA.filter((k) => k !== current);
      return pool[Math.floor(Math.random() * pool.length)];
    }
    function renderChips() {
      const box = $("chips");
      box.innerHTML = "";
      DATA.forEach((k) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = k.c;
        b.title = k.strokes.length + "画";
        if (cleared.has(k.c)) b.className = "done";
        b.addEventListener("click", () => go(k));
        box.appendChild(b);
      });
    }
    function go(k) { Engine.start(k, settings); }
    function enter() {
      Engine.setHooks({
        skip: () => go(pickNext(Engine.kanji)),
        afterReveal: () => [
          ["もう一回", "", () => go(Engine.kanji)],
          ["次の漢字", "primary", () => go(pickNext(Engine.kanji))],
        ],
        onReveal: ({ kanji }) => {
          cleared.add(kanji.c);
          store.set("hhmm-cleared", [...cleared]);
          renderChips();
        },
      });
      lockSettings(false);
      onSettingsChange = () => { if (Engine.kanji) go(Engine.kanji); };
      renderChips();
      go(Engine.kanji || byChar("顔") || DATA[0]);
    }
    return { enter };
  })();

  // ======================================================================
  // 3b. Online（同じお題を全員で同時に解き、結果を見せ合う）
  //   rooms/{CODE} = {
  //     host, createdAt,
  //     settings: { mode, blind },
  //     round: { n, kanji, mode, blind },          // n = 0 は待合室
  //     players/{pid}: { name, joinedAt },
  //     results/{n}/{pid}: { name, score, rank, pos: [[x,y],...] }
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
        const name = store.get("hhmm-name", "") || "ななし";
        o.be.set(`rooms/${o.code}/players/${pid}`, { name, joinedAt: Date.now() });
        return;
      }
      const host = isHost();
      if (host && room.host !== pid && !room.players[room.host]) o.be.update(`rooms/${o.code}`, { host: pid });

      // 設定：親だけが変えられる
      if (room.settings) {
        settings.mode = room.settings.mode;
        settings.blind = !!room.settings.blind;
        showSettings();
      }
      lockSettings(!host);

      const round = room.round || { n: 0 };
      const results = (room.results && room.results[round.n]) || {};
      renderPlayers(room, results);

      if (round.n > 0 && round.n !== o.startedRound) {
        o.startedRound = round.n;
        const k = byChar(round.kanji);
        if (k) Engine.start(k, { mode: round.mode, blind: !!round.blind });
      } else if (round.n === 0) {
        Engine.idle(waitingText(host));
        setActions(host ? [["はじめる", "primary", nextRound]] : []);
      }
      if (Engine.phase === "reveal") Engine.refreshActions();
      renderGallery(round, results);
    }

    function waitingText(host) {
      return host
        ? "みんなが集まったら<br>「はじめる」を押してください"
        : "親（部屋を作った人）が<br>はじめるのを待っています";
    }

    function renderPlayers(room, results) {
      const box = $("players");
      const list = Object.entries(room.players || {}).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
      const hostId = room.players[room.host] ? room.host : (list[0] && list[0][0]);
      box.innerHTML = list.map(([id, p]) => {
        const cls = [id === pid ? "me" : "", results[id] ? "done" : "", id === hostId ? "host" : ""].join(" ");
        return `<span class="${cls}">${esc(p.name)}</span>`;
      }).join("");
      const n = (room.round && room.round.n) || 0;
      const done = list.filter(([id]) => results[id]).length;
      if (n > 0) $("status").textContent = Engine.phase === "reveal" ? `${done} / ${list.length} 人が完成` : $("status").textContent;
    }

    function renderGallery(round, results) {
      const panel = $("galleryPanel");
      const entries = Object.entries(results);
      // 自分が答え合わせを終えるまでは、他の人の作品は見せない
      if (!round.n || !results[pid] || !entries.length) { panel.hidden = true; return; }
      const k = byChar(round.kanji);
      entries.sort((a, b) => b[1].score - a[1].score);
      const best = entries[0][1].score;
      $("gallery").innerHTML = entries.map(([id, r]) => `
        <figure class="${r.score === best ? "top" : ""}">
          ${arrangementSvg(k, round.mode, r.pos || [], false)}
          <figcaption><span class="who">${esc(r.name)}${id === pid ? "（あなた）" : ""}</span><span class="pt">${r.score}点・${esc(r.rank)}</span></figcaption>
        </figure>`).join("");
      panel.hidden = false;
    }

    async function nextRound() {
      const r = o.room;
      if (!r || !isHost()) return;
      const used = new Set(Object.values(r.usedKanji || {}));
      const pool = DATA.filter((k) => !used.has(k.c));
      const k = (pool.length ? pool : DATA)[Math.floor(Math.random() * (pool.length || DATA.length))];
      const n = ((r.round && r.round.n) || 0) + 1;
      await o.be.update(`rooms/${o.code}`, {
        round: { n, kanji: k.c, mode: settings.mode, blind: settings.blind },
        [`usedKanji/${n}`]: k.c,
        // 古い結果は消して部屋を軽く保つ
        [`results/${n - 2}`]: null,
      });
    }

    function enter() {
      o.active = true;
      $("joinView").hidden = !!o.code;
      $("roomView").hidden = !o.code;
      $("soloPanel").hidden = true;
      Engine.setHooks({
        onReveal: ({ score, rank, positions }) => {
          const n = o.room && o.room.round && o.room.round.n;
          if (!n || !o.code) return;
          const name = (o.room.players[pid] && o.room.players[pid].name) || "ななし";
          o.be.set(`rooms/${o.code}/results/${n}/${pid}`, { name, score, rank, pos: positions });
        },
        afterReveal: () => (isHost() ? [["次のお題", "primary", nextRound]] : []),
      });
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
