(() => {
  "use strict";
  const C = window.APP_CONFIG;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const LS = {
    get(k, d = "") { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const COLORS = ["var(--red)", "var(--orange)", "var(--blue)", "var(--purple)", "var(--green)"];
  const METRICS = [
    { k: "views", t: "Просмотры", c: "var(--blue)" },
    { k: "likes", t: "Лайки", c: "var(--red)" },
    { k: "followers", t: "Подписчики", c: "var(--orange)" },
    { k: "comments", t: "Комменты", c: "var(--purple)" },
    { k: "shares", t: "Репосты", c: "var(--green)" },
    { k: "videos", t: "Видео", c: "#8b909c" },
  ];
  const DAY = 86400e3;

  let S = { updated: null, accounts: {} };   // data/state.json
  let H = { points: [] };                      // data/history.json
  let ACC = [];                                // accounts.json
  let sel = LS.get("sel", "all");
  let statMode = LS.get("statMode", "all");
  let rankKey = "views", topKey = "plays", topLimit = 10, range = 30, chartMetric = "views";

  // ---------- форматирование ----------
  function fmt(n) {
    if (n == null || isNaN(n)) return "—";
    const a = Math.abs(n);
    const s = (v, u) => parseFloat(v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + u;
    if (a >= 1e9) return (n < 0 ? "-" : "") + s(a / 1e9, "B");
    if (a >= 1e6) return (n < 0 ? "-" : "") + s(a / 1e6, "M");
    if (a >= 1e4) return (n < 0 ? "-" : "") + s(a / 1e3, "K");
    return Math.round(n).toLocaleString("ru-RU");
  }
  const fmtD = (d) => (d == null ? "—" : d > 0 ? "+" + fmt(d) : d < 0 ? "−" + fmt(-d) : "±0");
  const dCls = (d) => (d > 0 ? "up" : d < 0 ? "down" : "");
  function ago(iso) {
    if (!iso) return "—";
    const m = Math.round((Date.now() - new Date(iso)) / 60e3);
    if (m < 1) return "только что";
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} ч назад`;
    return `${Math.round(h / 24)} дн назад`;
  }
  function age(iso) {
    if (!iso) return "";
    const h = (Date.now() - new Date(iso)) / 3600e3;
    if (h < 24) return `${Math.max(1, Math.round(h))} ч`;
    if (h < 24 * 60) return `${Math.round(h / 24)} д`;
    return `${Math.round(h / 24 / 30)} мес`;
  }
  function toast(msg, ms = 3500) {
    const t = $("#toast");
    t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
  }

  // ---------- GitHub ----------
  const token = () => LS.get("gh_token");
  async function gh(path, opts = {}) {
    const r = await fetch(`https://api.github.com/repos/${C.owner}/${C.repo}${path}`, {
      ...opts, cache: "no-store",
      headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
    });
    if (!r.ok && r.status !== 204) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return r.status === 204 ? null : r.json();
  }
  async function loadFile(path) {
    if (token()) {
      try {
        const r = await fetch(`https://api.github.com/repos/${C.owner}/${C.repo}/contents/${path}?ref=${C.branch}`, {
          cache: "no-store", headers: { Authorization: `Bearer ${token()}`, Accept: "application/vnd.github.raw+json" },
        });
        if (r.ok) return r.json();
      } catch {}
    }
    const onPages = location.hostname.endsWith("github.io");
    const url = onPages ? `https://raw.githubusercontent.com/${C.owner}/${C.repo}/${C.branch}/${path}?t=${Date.now()}` : `${path}?t=${Date.now()}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }
  const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64dec = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));

  async function editAccounts(fn) {
    const f = await gh(`/contents/accounts.json?ref=${C.branch}`);
    const cfg = JSON.parse(b64dec(f.content));
    cfg.accounts = cfg.accounts || [];
    const msg = fn(cfg);
    await gh(`/contents/accounts.json`, { method: "PUT", body: JSON.stringify({ message: msg, content: b64enc(JSON.stringify(cfg, null, 2) + "\n"), sha: f.sha, branch: C.branch }) });
    ACC = cfg.accounts;
  }

  let watching = false;
  async function dispatch(mode = "auto") {
    if (!token()) { toast("Сначала добавь GitHub-токен в настройках"); openSheet(); return; }
    const since = Date.now() - 5000;
    await gh(`/actions/workflows/${C.workflow}/dispatches`, { method: "POST", body: JSON.stringify({ ref: C.branch, inputs: { mode } }) });
    toast("Сбор запущен — обычно 1–4 минуты");
    watchRun(since);
  }
  async function watchRun(since) {
    if (watching) return;
    watching = true; setBusy(true);
    const until = Date.now() + 25 * 60e3;
    try {
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 10000));
        const runs = await gh(`/actions/workflows/${C.workflow}/runs?per_page=3&event=workflow_dispatch`);
        const run = (runs.workflow_runs || []).find((x) => new Date(x.created_at) >= since);
        if (run && run.status === "completed") {
          await new Promise((r) => setTimeout(r, 4000));
          await loadAll();
          toast(run.conclusion === "success" ? "Статистика обновлена ✓" : "Сбор завершился с ошибкой — смотри Actions на GitHub", 5000);
          return;
        }
      }
      toast("Сбор идёт слишком долго — проверь вкладку Actions");
    } catch (e) { toast(e.message); }
    finally { watching = false; setBusy(false); }
  }
  function setBusy(b) {
    const btn = $("#btnRefresh");
    btn.disabled = b; btn.classList.toggle("spin", b);
    btn.querySelector("span").textContent = b ? "Собираю…" : "Обновить всё";
  }

  // ---------- вычисления ----------
  const accNames = () => {
    const fromCfg = ACC.map((a) => (typeof a === "string" ? a : a.username).toLowerCase());
    return [...new Set([...fromCfg, ...Object.keys(S.accounts)])];
  };
  const selected = () => (sel === "all" ? accNames() : [sel]);
  const totalsOf = (u) => S.accounts[u]?.totals || null;
  const profileOf = (u) => S.accounts[u]?.profile || null;

  function delta24(u, key) {
    const pts = H.points.filter((p) => p.a[u]);
    if (pts.length < 2) return null;
    const cur = pts[pts.length - 1];
    const target = new Date(cur.t) - DAY;
    let base = null;
    for (const p of pts) { if (new Date(p.t) <= target) base = p; else break; }
    if (!base) base = pts[0];
    if (base === cur) return null;
    return cur.a[u][key] - base.a[u][key];
  }
  function sumDelta(users, key) {
    let any = false, s = 0;
    for (const u of users) { const d = delta24(u, key); if (d != null) { any = true; s += d; } }
    return any ? s : null;
  }
  function sumTotals(users) {
    const t = { views: 0, likes: 0, followers: 0, comments: 0, shares: 0, videos: 0 };
    let any = false;
    for (const u of users) { const x = totalsOf(u); if (!x) continue; any = true; for (const k in t) t[k] += x[k] || 0; }
    return any ? t : null;
  }
  function daily(users, key) {
    const last = {}, byDay = new Map();
    for (const p of H.points) {
      for (const u of users) if (p.a[u]) last[u] = p.a[u][key];
      if (!Object.keys(last).length) continue;
      const day = p.t.slice(0, 10);
      byDay.set(day, Object.values(last).reduce((a, b) => a + b, 0));
    }
    let arr = [...byDay].map(([d, v]) => ({ d, v }));
    if (range) { const from = new Date(Date.now() - range * DAY).toISOString().slice(0, 10); arr = arr.filter((x) => x.d >= from); }
    return arr;
  }
  function videosOf(users) {
    const out = [];
    for (const u of users) for (const v of Object.values(S.accounts[u]?.videos || {})) out.push({ ...v, owner: u });
    return out;
  }
  function gain24(v) {
    const h = v.h || [];
    if (h.length < 2) return 0;
    const target = new Date(h[h.length - 1][0]) - DAY;
    let base = h[0];
    for (const e of h) { if (new Date(e[0]) <= target) base = e; else break; }
    return v.plays - base[1];
  }

  // ---------- отрисовка ----------
  const color = (u) => COLORS[Math.max(0, accNames().indexOf(u)) % COLORS.length];
  function avatar(u, cls = "") {
    const p = profileOf(u);
    const letter = esc((p?.nickname || u)[0]?.toUpperCase() || "?");
    if (p?.avatar) return `<img class="ava ${cls}" src="${esc(p.avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;ava ${cls}&quot;>${letter}</span>'">`;
    return `<span class="ava ${cls}">${letter}</span>`;
  }

  function renderChips() {
    const names = accNames();
    $("#accCount").textContent = `${names.length} ${plural(names.length, "аккаунт", "аккаунта", "аккаунтов")}`;
    const all = sumTotals(names);
    const allD = sumDelta(names, "views");
    let h = `<button class="panel acc ${sel === "all" ? "on" : ""}" data-u="all">
      <i class="bar" style="background:var(--blue)"></i><span class="dots">···</span>
      <div class="name"><span class="ava all-ico"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="4" width="6" height="6" rx="1.5"/><rect x="4" y="14" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/></svg></span><span>Все аккаунты</span></div>
      <div class="meta"><span>${fmt(all?.views)} просм.</span><span class="${allD > 0 ? "up-t" : ""}">${allD != null ? fmtD(allD) + " / 24 ч" : ""}</span></div></button>`;
    for (const u of names) {
      const t = totalsOf(u), p = profileOf(u), d = delta24(u, "views"), err = S.accounts[u]?.error;
      h += `<button class="panel acc ${sel === u ? "on" : ""}" data-u="${esc(u)}">
        <i class="bar" style="background:${color(u)}"></i><span class="dots">···</span>
        <div class="name">${avatar(u)}<span>${esc(p?.nickname || "@" + u)}</span></div>
        <div class="meta"><span>${t ? fmt(t.views) + " просм." : err ? "⚠ ошибка" : "ждёт сбора"}</span><span class="${d > 0 ? "up-t" : ""}">${d != null ? fmtD(d) + " / 24 ч" : "@" + esc(u)}</span></div></button>`;
    }
    $("#accChips").innerHTML = h;
  }

  // h: [t, plays, likes, comments, shares, saves]
  const VMET = [
    { k: "plays", i: 1, t: "Просмотры", c: "var(--blue)" },
    { k: "likes", i: 2, t: "Лайки", c: "var(--red)" },
    { k: "comments", i: 3, t: "Комменты", c: "var(--purple)" },
    { k: "shares", i: 4, t: "Репосты", c: "var(--green)" },
    { k: "saves", i: 5, t: "Сохранения", c: "var(--orange)" },
  ];
  function vDelta(v, i) {
    const h = (v.h || []).filter((e) => e.length > i);
    if (h.length < 2) return null;
    const target = new Date(h[h.length - 1][0]) - DAY;
    let base = h[0];
    for (const e of h) { if (new Date(e[0]) <= target) base = e; else break; }
    return h[h.length - 1][i] - base[i];
  }
  function renderLastVideo() {
    const v = videosOf(selected()).filter((x) => x.created).sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
    if (!v) { $("#lastVideo").innerHTML = ""; $("#metrics").innerHTML = `<div class="panel empty-box" style="grid-column:1/-1">Видео появятся после первого сбора</div>`; return; }
    $("#lastVideo").innerHTML = vcard(v, `<span class="chip">опубликовано ${age(v.created)} назад</span>`);
    const er = v.plays ? ((v.likes + v.comments + v.shares) / v.plays) * 100 : 0;
    $("#metrics").innerHTML = VMET.map((m) => {
      const d = vDelta(v, m.i);
      return `<div class="panel metric" style="--c:${m.c}"><div class="k">${m.t}</div><div class="v">${fmt(v[m.k])}</div>
        <span class="delta ${dCls(d)}">${fmtD(d)}</span><small>24 ч</small></div>`;
    }).join("") + `<div class="panel metric" style="--c:#8b909c"><div class="k">Вовлечённость</div><div class="v">${er.toFixed(1).replace(".", ",")}%</div>
        <span class="delta">ER</span></div>`;
  }

  function renderMetrics() {
    const users = selected();
    $("#statToggle").classList.toggle("last", statMode === "last");
    $$("#statToggle button").forEach((b) => b.classList.toggle("on", b.dataset.m === statMode));
    $("#updated").textContent = S.updated ? "обновлено " + ago(S.updated) : "";
    $("#statsTitle").textContent = sel === "all" ? "Статистика" : profileOf(sel)?.nickname || "@" + sel;
    if (statMode === "last") return renderLastVideo();
    $("#lastVideo").innerHTML = "";
    const t = sumTotals(users);
    $("#metrics").innerHTML = METRICS.map((m) => {
      const d = sumDelta(users, m.k);
      return `<div class="panel metric" style="--c:${m.c}"><div class="k">${m.t}</div><div class="v">${fmt(t?.[m.k])}</div>
        <span class="delta ${dCls(d)}">${fmtD(d)}</span><small>24 ч</small></div>`;
    }).join("");
  }

  function renderChart() {
    const m = METRICS.find((x) => x.k === chartMetric);
    $("#chartTitle").textContent = m.t;
    const data = daily(selected(), chartMetric);
    const box = $("#chart");
    if (data.length < 2) {
      $("#chartSub").textContent = "";
      box.innerHTML = `<div class="empty">График появится, когда наберётся хотя бы 2 дня сборов</div>`;
      return;
    }
    const diff = data[data.length - 1].v - data[0].v;
    $("#chartSub").innerHTML = `<span class="${diff >= 0 ? "up-t" : "down-t"}">${fmtD(diff)}</span> за ${range ? range + " дн." : "всё время"}`;
    const W = Math.max(240, box.clientWidth || 340), Hh = 190, pl = 6, pr = 6, pt = 14, pb = 26;
    const vs = data.map((d) => d.v);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const x = (i) => pl + (i * (W - pl - pr)) / (data.length - 1);
    const y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (Hh - pt - pb);
    const P = data.map((d, i) => [x(i), y(d.v)]);
    let path = `M${P[0][0]},${P[0][1]}`;
    for (let i = 1; i < P.length; i++) {
      const [x0, y0] = P[i - 1], [x1, y1] = P[i], cx = (x0 + x1) / 2;
      path += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
    }
    const area = `${path} L${P[P.length - 1][0]},${Hh - pb} L${P[0][0]},${Hh - pb} Z`;
    const last = P[P.length - 1];
    const dd = (s) => { const [, mo, da] = s.split("-"); return `${+da}.${mo}`; };
    const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${pt + f * (Hh - pt - pb)}" y2="${pt + f * (Hh - pt - pb)}" stroke="rgba(255,255,255,.05)"/>`).join("");
    box.innerHTML = `<svg viewBox="0 0 ${W} ${Hh}">
      <defs>
        <linearGradient id="gf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b7bff" stop-opacity=".45"/><stop offset="1" stop-color="#3b7bff" stop-opacity="0"/></linearGradient>
        <linearGradient id="gl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7a5cff"/><stop offset="1" stop-color="#4d9bff"/></linearGradient>
        <filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#gf)" stroke="none"/>
      <path d="${path}" fill="none" stroke="url(#gl)" stroke-width="3" filter="url(#glow)" vector-effect="non-scaling-stroke"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="5" fill="#fff" stroke="#3b7bff" stroke-width="3" vector-effect="non-scaling-stroke"/>
      <text x="${pl}" y="${Hh - 6}" fill="#6f7480" font-size="11">${dd(data[0].d)}</text>
      <text x="${W - pr}" y="${Hh - 6}" fill="#6f7480" font-size="11" text-anchor="end">${dd(data[data.length - 1].d)}</text>
      <text x="${W - pr}" y="${Math.max(12, last[1] - 12)}" fill="#fff" font-size="12" font-weight="700" text-anchor="end">${fmt(data[data.length - 1].v)}</text>
    </svg>`;
  }

  function renderRanking() {
    const rows = accNames().map((u) => {
      const t = totalsOf(u);
      const g = delta24(u, "views");
      const v = rankKey === "growth" ? g : t?.[rankKey];
      return { u, t, g, v };
    }).sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
    if (!rows.length) { $("#rankList").innerHTML = `<div class="empty-box">Добавь первый аккаунт через поле сверху</div>`; return; }
    $("#rankList").innerHTML = rows.map((r, i) => {
      const main = rankKey === "growth" ? fmtD(r.g) : fmt(r.v);
      const sub = rankKey === "followers" ? fmtD(delta24(r.u, "followers")) : rankKey === "growth" ? fmt(r.t?.views) + " всего" : fmtD(r.g);
      const subCls = rankKey === "growth" ? "muted" : dCls(rankKey === "followers" ? delta24(r.u, "followers") : r.g) + "-t";
      return `<button class="rank" data-u="${esc(r.u)}"><span class="n">${i + 1}</span>${avatar(r.u, "lg")}
        <span class="who"><b>${esc(profileOf(r.u)?.nickname || r.u)}</b><span class="muted small">@${esc(r.u)}</span></span>
        <span class="val">${main}<small class="${subCls}">${sub}</small></span></button>`;
    }).join("");
  }

  function vcard(v, extra = "") {
    const img = v.cover ? `<img src="${esc(v.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;noimg&quot;></span>'">` : `<span class="noimg"></span>`;
    return `<a class="panel vcard" href="${esc(v.url || "https://www.tiktok.com/@" + v.owner)}" target="_blank" rel="noopener">
      <i class="bar" style="background:${color(v.owner)}"></i>${img}
      <div class="body"><div class="t">${esc(v.text || "Без описания")}</div>
      <div class="s">@${esc(v.owner)} · ${fmt(v.plays)} просм. · ${fmt(v.likes)} ❤</div>${extra}</div></a>`;
  }

  function renderRising() {
    const list = videosOf(selected()).map((v) => ({ ...v, g: gain24(v) })).filter((v) => v.g > 0).sort((a, b) => b.g - a.g).slice(0, 6);
    $("#rising").innerHTML = list.length
      ? list.map((v) => `<div class="tl"><div class="when">${age(v.created)}</div>${vcard(v, `<span class="chip g">${fmtD(v.g)} за 24 ч</span>`)}</div>`).join("")
      : `<div class="panel empty-box">Пока нечего показать — нужно минимум 2 сбора</div>`;
  }

  function renderTop() {
    const all = videosOf(selected());
    const sortFn = topKey === "created" ? (a, b) => String(b.created).localeCompare(String(a.created)) : (a, b) => (b[topKey] || 0) - (a[topKey] || 0);
    const list = all.sort(sortFn);
    $("#topVideos").innerHTML = list.length
      ? list.slice(0, topLimit).map((v) => vcard(v, `<span class="chip">${age(v.created)} · 💬 ${fmt(v.comments)} · ↗ ${fmt(v.shares)}</span>`)).join("")
      : `<div class="panel empty-box">Видео появятся после первого сбора</div>`;
    $("#moreVideos").classList.toggle("hidden", list.length <= topLimit);
  }

  function renderManage() {
    const names = accNames();
    $("#manageList").innerHTML = names.length ? names.map((u) => `<div class="rank">${avatar(u)}
      <span class="who"><b>@${esc(u)}</b><span class="muted small">${S.accounts[u]?.error ? "⚠ " + esc(S.accounts[u].error) : S.accounts[u]?.lastQuick ? "собран " + ago(S.accounts[u].lastQuick) : "ждёт сбора"}</span></span>
      <button class="del" data-del="${esc(u)}">Удалить</button></div>`).join("") : `<p class="muted small">Пока пусто</p>`;
    const lastFull = Object.values(S.accounts).map((a) => a.lastFull).filter(Boolean).sort()[0];
    $("#collectInfo").innerHTML = `Автосбор каждые 6 ч: профиль + ~10 свежих видео (дёшево). Полный пересчёт всех видео — у нового аккаунта и раз в 30 дней (дороже).<br>Последний сбор: <b>${ago(S.updated)}</b>${lastFull ? ` · самый старый полный: ${ago(lastFull)}` : ""}`;
    const t = token();
    $("#tokenState").innerHTML = t ? `<span class="up-t">✓ сохранён</span>` : `<span class="muted">не задан</span>`;
    $("#errDot").classList.toggle("hidden", !Object.values(S.accounts).some((a) => a.error));
  }

  function renderAll() {
    if (sel !== "all" && !accNames().includes(sel)) sel = "all";
    renderChips(); renderMetrics(); renderChart(); renderRanking(); renderRising(); renderTop(); renderManage();
    $("#foot").textContent = S.updated ? `Данные: ${new Date(S.updated).toLocaleString("ru-RU")} · TikTok · Apify` : "Данных пока нет";
  }
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };

  async function loadAll() {
    const [s, h, a] = await Promise.allSettled([loadFile("data/state.json"), loadFile("data/history.json"), loadFile("accounts.json")]);
    if (s.status === "fulfilled") S = s.value;
    if (h.status === "fulfilled") H = h.value;
    if (a.status === "fulfilled") ACC = a.value.accounts || [];
    H.points = (H.points || []).sort((x, y) => x.t.localeCompare(y.t));
    renderAll();
    if (s.status === "rejected") toast("Не удалось загрузить данные: " + s.reason.message);
  }

  // ---------- действия ----------
  function parseUser(s) {
    s = s.trim();
    const m = s.match(/tiktok\.com\/@([^/?#\s]+)/i);
    if (m) s = m[1];
    s = s.replace(/^@/, "").toLowerCase();
    return /^[a-z0-9._]{2,24}$/.test(s) ? s : null;
  }
  async function addAccount() {
    const u = parseUser($("#addInput").value);
    if (!u) { toast("Введи @ник или ссылку вида tiktok.com/@ник"); return; }
    if (accNames().includes(u)) { toast("Этот аккаунт уже добавлен"); return; }
    if (!token()) { toast("Чтобы добавлять аккаунты, сохрани GitHub-токен в настройках"); openSheet(); return; }
    try {
      toast("Добавляю @" + u + "…");
      await editAccounts((cfg) => { cfg.accounts.push({ username: u, added: new Date().toISOString() }); return `add @${u}`; });
      $("#addInput").value = "";
      renderAll();
      await dispatch("auto");
    } catch (e) { toast(e.message, 6000); }
  }
  async function removeAccount(u) {
    if (!confirm(`Удалить @${u} из отслеживания? История останется в файлах.`)) return;
    try {
      await editAccounts((cfg) => { cfg.accounts = cfg.accounts.filter((a) => (typeof a === "string" ? a : a.username).toLowerCase() !== u); return `remove @${u}`; });
      delete S.accounts[u];
      if (sel === u) sel = "all";
      renderAll(); toast(`@${u} удалён`);
    } catch (e) { toast(e.message, 6000); }
  }
  function csv(name, rows) {
    const body = rows.map((r) => r.map((c) => { const s = String(c ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function openSheet() { renderManage(); $("#ghToken").value = token(); $("#sheet").classList.remove("hidden"); }
  function closeSheet() { $("#sheet").classList.add("hidden"); }

  function bind() {
    $("#addForm").addEventListener("submit", (e) => { e.preventDefault(); addAccount(); });
    $("#fab").addEventListener("click", () => { window.scrollTo({ top: 0, behavior: "smooth" }); setTimeout(() => $("#addInput").focus(), 300); });
    $("#accChips").addEventListener("click", (e) => { const b = e.target.closest("[data-u]"); if (!b) return; sel = b.dataset.u; LS.set("sel", sel); topLimit = 10; renderAll(); });
    $("#rankList").addEventListener("click", (e) => { const b = e.target.closest("[data-u]"); if (!b) return; sel = b.dataset.u; LS.set("sel", sel); renderAll(); window.scrollTo({ top: $("#stats").offsetTop - 10, behavior: "smooth" }); });
    $("#rankSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; rankKey = b.dataset.k; $$("#rankSeg button").forEach((x) => x.classList.toggle("on", x === b)); renderRanking(); });
    $("#topSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; topKey = b.dataset.k; topLimit = 10; $$("#topSeg button").forEach((x) => x.classList.toggle("on", x === b)); renderTop(); });
    $("#statToggle").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b || b.dataset.m === statMode) return; statMode = b.dataset.m; LS.set("statMode", statMode); renderMetrics(); });
    $("#moreVideos").addEventListener("click", () => { topLimit += 10; renderTop(); });
    $("#rangePills").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; range = +b.dataset.r; $$("#rangePills .pill").forEach((x) => x.classList.toggle("on", x === b)); renderChart(); });
    $("#chartMetric").addEventListener("change", (e) => { chartMetric = e.target.value; renderChart(); });
    $("#btnRefresh").addEventListener("click", () => dispatch("auto").catch((e) => toast(e.message, 6000)));
    $("#btnSettings").addEventListener("click", openSheet);
    $("#dockSettings").addEventListener("click", openSheet);
    $("#closeSheet").addEventListener("click", closeSheet);
    $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
    $("#saveToken").addEventListener("click", async () => {
      const v = $("#ghToken").value.trim();
      if (!v) { LS.del("gh_token"); renderManage(); toast("Токен удалён"); return; }
      LS.set("gh_token", v);
      try { await gh(""); toast("Токен работает ✓"); await loadAll(); }
      catch (e) { toast("Токен не подошёл: " + e.message, 6000); }
      renderManage();
    });
    $("#manageList").addEventListener("click", (e) => { const b = e.target.closest("[data-del]"); if (b) removeAccount(b.dataset.del); });
    $$("[data-mode]").forEach((b) => b.addEventListener("click", () => { closeSheet(); dispatch(b.dataset.mode).catch((e) => toast(e.message, 6000)); }));
    $("#csvHistory").addEventListener("click", () => {
      const rows = [["date", "account", "views", "likes", "followers", "comments", "shares", "videos"]];
      for (const p of H.points) for (const [u, t] of Object.entries(p.a)) rows.push([p.t, u, t.views, t.likes, t.followers, t.comments, t.shares, t.videos]);
      csv("tiktok-history.csv", rows);
    });
    $("#csvVideos").addEventListener("click", () => {
      const rows = [["account", "id", "url", "created", "views", "likes", "comments", "shares", "saves", "gain_24h", "text"]];
      for (const v of videosOf(accNames())) rows.push([v.owner, v.id, v.url, v.created, v.plays, v.likes, v.comments, v.shares, v.saves, gain24(v), v.text]);
      csv("tiktok-videos.csv", rows);
    });
    $("#logout").addEventListener("click", () => { LS.del("auth"); LS.del("gh_token"); location.reload(); });
    let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(renderChart, 150); });
    $$(".dock a").forEach((a) => a.addEventListener("click", () => { $$(".dock a").forEach((x) => x.classList.toggle("on", x === a)); }));
  }

  // ---------- старт ----------
  async function sha256(s) {
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  function greet() {
    const h = new Date().getHours();
    $("#greet").textContent = h < 5 ? "Доброй ночи 🌙" : h < 12 ? "Доброе утро ☀️" : h < 18 ? "Добрый день 👋" : "Добрый вечер 🌆";
  }
  function start() {
    $("#gate").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#dock").classList.remove("hidden");
    greet(); bind(); loadAll();
    setInterval(() => { if (!watching && document.visibilityState === "visible") loadAll(); }, 5 * 60e3);
  }
  if (!C.passHash || LS.get("auth") === C.passHash) start();
  else {
    $("#gate").classList.remove("hidden");
    $("#gateForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const h = await sha256($("#gatePass").value);
      if (h === C.passHash) { LS.set("auth", h); start(); }
      else $("#gateErr").textContent = "Неверный пароль";
    });
  }
})();
