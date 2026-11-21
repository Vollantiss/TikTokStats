// Сборщик статистики TikTok через Apify. Запускается GitHub Actions.
// Быстрый сбор (каждые 6 ч): dami_studio~tiktok-scraper — профиль + ~10 свежих видео, ~$0.25/1000 строк.
// Полный пересчёт (новый аккаунт или раз в FULL_EVERY_DAYS): clockworks~tiktok-scraper — все видео до FULL_MAX.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const TOKEN = process.env.APIFY_TOKEN;
const MODE = (process.env.MODE || "auto").toLowerCase(); // auto | quick | full
const QUICK_ACTOR = process.env.QUICK_ACTOR || "dami_studio~tiktok-scraper";
const FULL_ACTOR = process.env.FULL_ACTOR || "clockworks~tiktok-scraper";
const QUICK_PER_PROFILE = 12;
const FULL_MAX = Number(process.env.FULL_MAX || 300);
const FULL_EVERY_DAYS = Number(process.env.FULL_EVERY_DAYS || 30);
const HIST_KEEP_MS = 3 * 24 * 3600e3;

if (!TOKEN) {
  console.error("Нет APIFY_TOKEN. Добавь секрет в Settings → Secrets and variables → Actions.");
  process.exit(1);
}

const readJson = async (p, def) => {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return def; }
};
const norm = (u) => String(u || "").trim().replace(/^@/, "").toLowerCase();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

async function api(path, opts = {}) {
  const res = await fetch(`https://api.apify.com/v2${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Apify ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function runActor(actor, input) {
  console.log(`▶ ${actor}`, JSON.stringify(input));
  let run = (await api(`/acts/${actor}/runs?waitForFinish=60`, { method: "POST", body: JSON.stringify(input) })).data;
  const started = Date.now();
  while (["READY", "RUNNING"].includes(run.status)) {
    if (Date.now() - started > 20 * 60e3) throw new Error("Apify run timeout");
    run = (await api(`/actor-runs/${run.id}?waitForFinish=60`)).data;
  }
  console.log(`  статус ${run.status}, стоимость ~$${num(run.usageTotalUsd).toFixed(3)}`);
  if (run.status !== "SUCCEEDED") throw new Error(`Run ${run.id} ${run.status}`);
  const items = await api(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json`);
  console.log(`  строк: ${items.length}`);
  return items;
}

// ---------- нормализация ----------
function videoFromDami(r) {
  return {
    id: String(r.id),
    owner: norm(r.author?.uniqueId),
    url: r.webVideoUrl || "",
    text: (r.text || "").slice(0, 200),
    cover: r.video?.cover || "",
    created: r.createTime ? new Date(r.createTime).toISOString() : null,
    plays: num(r.playCount), likes: num(r.diggCount), comments: num(r.commentCount),
    shares: num(r.shareCount), saves: num(r.collectCount),
  };
}
function videoFromClockworks(r) {
  return {
    id: String(r.id),
    owner: norm(r.authorMeta?.name),
    url: r.webVideoUrl || "",
    text: (r.text || "").slice(0, 200),
    cover: r.videoMeta?.coverUrl || r.videoMeta?.originalCoverUrl || "",
    created: r.createTimeISO || (r.createTime ? new Date(r.createTime * 1000).toISOString() : null),
    plays: num(r.playCount), likes: num(r.diggCount), comments: num(r.commentCount),
    shares: num(r.shareCount), saves: num(r.collectCount),
  };
}
function profileFromClockworks(a) {
  return { nickname: a.nickName || a.name, avatar: a.avatar || "", followers: num(a.fans), likes: num(a.heart), videoCount: num(a.video) };
}

// ---------- основная логика ----------
const now = new Date();
const nowIso = now.toISOString();
const cfg = await readJson("accounts.json", { accounts: [] });
const usernames = [...new Set((cfg.accounts || []).map((a) => norm(typeof a === "string" ? a : a.username)).filter(Boolean))];
const state = await readJson("data/state.json", { updated: null, accounts: {} });
const history = await readJson("data/history.json", { points: [] });

for (const u of Object.keys(state.accounts)) if (!usernames.includes(u)) delete state.accounts[u];
for (const u of usernames) state.accounts[u] ||= { profile: null, lastFull: null, lastQuick: null, videos: {}, error: null };

if (!usernames.length) { console.log("Аккаунтов нет — выходим."); process.exit(0); }

function upsertVideo(u, v) {
  const acc = state.accounts[u];
  if (!acc || !v.id) return;
  const old = acc.videos[v.id] || { h: [] };
  const h = (old.h || []).filter(([t]) => now - new Date(t) < HIST_KEEP_MS);
  if (!h.length || h[h.length - 1][1] !== v.plays) h.push([nowIso, v.plays]);
  const { owner, ...rest } = v;
  acc.videos[v.id] = { ...old, ...rest, cover: rest.cover || old.cover || "", h };
}

const fullTargets = usernames.filter((u) => {
  if (MODE === "full") return true;
  if (MODE === "quick") return false;
  const lf = state.accounts[u].lastFull;
  return !lf || now - new Date(lf) > FULL_EVERY_DAYS * 86400e3;
});
const quickTargets = usernames.filter((u) => !fullTargets.includes(u));
const failed = new Set();

// Быстрый сбор
if (quickTargets.length) {
  const got = new Set();
  try {
    const rows = await runActor(QUICK_ACTOR, {
      profiles: quickTargets, resultsPerInput: QUICK_PER_PROFILE, maxRunSeconds: 180,
    });
    for (const r of rows) {
      if (r.ok === false) continue;
      if (r.type === "profile") {
        const u = norm(r.uniqueId);
        if (!state.accounts[u]) continue;
        state.accounts[u].profile = {
          nickname: r.nickname || u, avatar: r.avatar || state.accounts[u].profile?.avatar || "",
          followers: num(r.followerCount), likes: num(r.heartCount), videoCount: num(r.videoCount),
        };
        got.add(u);
      } else if (r.type === "video" || r.playCount !== undefined) {
        const v = videoFromDami(r);
        upsertVideo(v.owner, v);
      }
    }
  } catch (e) { console.error("Быстрый актор упал:", e.message); }
  // запасной вариант: то, что не пришло, добираем clockworks'ом
  const missing = quickTargets.filter((u) => !got.has(u));
  if (missing.length) {
    console.log("Запасной сбор для:", missing.join(", "));
    try {
      const rows = await runActor(FULL_ACTOR, {
        profiles: missing, resultsPerPage: QUICK_PER_PROFILE, profileSorting: "latest",
        shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadAvatars: false,
      });
      for (const r of rows) {
        if (r.errorCode || !r.authorMeta) continue;
        const v = videoFromClockworks(r);
        if (!missing.includes(v.owner)) continue;
        state.accounts[v.owner].profile = profileFromClockworks(r.authorMeta);
        got.add(v.owner);
        upsertVideo(v.owner, v);
      }
    } catch (e) { console.error("Запасной сбор упал:", e.message); }
  }
  for (const u of quickTargets) {
    if (got.has(u)) { state.accounts[u].lastQuick = nowIso; state.accounts[u].error = null; }
    else { failed.add(u); state.accounts[u].error = `Не удалось собрать ${nowIso}`; }
  }
}

// Полный пересчёт
if (fullTargets.length) {
  try {
    const rows = await runActor(FULL_ACTOR, {
      profiles: fullTargets, resultsPerPage: FULL_MAX, profileSorting: "latest",
      shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadAvatars: false,
    });
    const got = new Set();
    for (const r of rows) {
      if (r.errorCode || !r.authorMeta) continue;
      const v = videoFromClockworks(r);
      if (!fullTargets.includes(v.owner)) continue;
      state.accounts[v.owner].profile = profileFromClockworks(r.authorMeta);
      got.add(v.owner);
      upsertVideo(v.owner, v);
    }
    for (const u of fullTargets) {
      if (got.has(u)) Object.assign(state.accounts[u], { lastFull: nowIso, lastQuick: nowIso, error: null });
      else { failed.add(u); state.accounts[u].error = `Профиль не найден или закрыт (${nowIso})`; }
    }
  } catch (e) {
    console.error("Полный сбор упал:", e.message);
    fullTargets.forEach((u) => { failed.add(u); state.accounts[u].error = e.message.slice(0, 200); });
  }
}

// Итоги и точка истории
const point = { t: nowIso, a: {} };
for (const u of usernames) {
  const acc = state.accounts[u];
  if (!acc.profile) continue;
  const vids = Object.values(acc.videos);
  const totals = {
    views: vids.reduce((s, v) => s + v.plays, 0),
    likes: acc.profile.likes || vids.reduce((s, v) => s + v.likes, 0),
    followers: acc.profile.followers,
    comments: vids.reduce((s, v) => s + v.comments, 0),
    shares: vids.reduce((s, v) => s + v.shares, 0),
    videos: acc.profile.videoCount || vids.length,
  };
  acc.totals = totals;
  if (!failed.has(u)) point.a[u] = totals;
}
if (Object.keys(point.a).length) history.points.push(point);
state.updated = nowIso;

await mkdir("data", { recursive: true });
await writeFile("data/state.json", JSON.stringify(state));
await writeFile("data/history.json", JSON.stringify(history));
console.log(`Готово: ${Object.keys(point.a).length}/${usernames.length} аккаунтов. Ошибки: ${[...failed].join(", ") || "нет"}`);
if (failed.size === usernames.length) process.exit(1);
