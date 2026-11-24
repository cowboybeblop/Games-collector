// Récupère tous les jeux "Coming soon" du store Steam avec un maximum d'infos.
// Usage : node steam_upcoming.mjs        (Node 18+, aucune dépendance)
//
// Étape 1 : pagine la recherche du store  -> liste complète (nom, date, plateformes, prix, images)
// Étape 2 : lit la page de chaque jeu     -> description, devs, éditeurs, genres, tags,
//                                            catégories, langues, site web, captures, trailer
//           Les fiches sont mises en cache (details.json) : seuls les nouveaux jeux sont lus ensuite.
//
// Mode test de vitesse : TEST=true node steam_upcoming.mjs
//
// Variables d'environnement :
//   DELAY_MS     pause entre deux pages de jeu (défaut 1000)
//   MAX_MINUTES  budget de temps pour l'étape 2 (défaut 300)
//   STALE_DAYS   re-lit les fiches plus vieilles que N jours (défaut 14)
//   TEST         "true" ou "1" pour le test de vitesse (n'écrit aucun fichier)

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DELAY_MS = Number(process.env.DELAY_MS || 1000);
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 300);
const STALE_DAYS = Number(process.env.STALE_DAYS || 14);
const TEST = ["true", "1"].includes(String(process.env.TEST));
const DUMP = ["true", "1"].includes(String(process.env.DUMP));
const PAGE = 50;
const SEARCH_DELAY = 1200;
const T0 = Date.now();
const outOfTime = () => (Date.now() - T0) / 60000 > MAX_MINUTES;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

const UA = "Mozilla/5.0 (steam-upcoming-script)";
const COOKIE = "birthtime=315532801; lastagecheckage=1-0-1980; wants_mature_content=1";

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
   .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
const stripTags = (s) => decode(s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
const uniq = (a) => [...new Set(a)];
const all = (html, re) => uniq([...html.matchAll(re)].map((m) => decode(m[1])).filter(Boolean));

async function fetchRetry(url, opts = {}, tries = 5, waitMs = 5000) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { "User-Agent": UA, "Accept-Language": "en", ...(opts.headers ?? {}) },
      });
      if (res.ok) return res;
      console.warn(`HTTP ${res.status} sur ${url.slice(0, 90)} (essai ${i}/${tries})`);
    } catch (e) {
      console.warn(`Erreur réseau (${e.message}) essai ${i}/${tries}`);
    }
    await sleep(waitMs * i);
  }
  throw new Error(`Échec définitif : ${url.slice(0, 90)}`);
}

// ---------- Étape 1 : recherche ----------
function parseRows(html) {
  const out = [];
  const re = /<a[^>]*data-ds-appid="([\d,]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const appid = Number(m[1].split(",")[0]);
    const title = /<span class="title">([\s\S]*?)<\/span>/.exec(m[2]);
    const rel = /search_released[^>]*>\s*([^<]*)</.exec(m[2]);
    const price = /<div class="col search_price[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(m[2]);
    out.push({
      appid,
      name: title ? decode(title[1]) : "",
      release: rel ? decode(rel[1]) : "",
      price: price ? stripTags(price[1]) : "",
      platforms: [...m[2].matchAll(/platform_img (win|mac|linux)/g)].map((x) => x[1]),
      url: `https://store.steampowered.com/app/${appid}`,
      image: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`,
      capsule: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`,
    });
  }
  return out;
}

async function scrapeSearch(maxPages = Infinity) {
  const games = new Map();
  let start = 0, total = Infinity, pages = 0;
  while (start < total && pages < maxPages) {
    const params = new URLSearchParams({
      filter: "comingsoon", start: String(start), count: String(PAGE),
      infinite: "1", cc: "fr", l: "english", category1: "998", // 998 = jeux uniquement
    });
    const res = await fetchRetry(`https://store.steampowered.com/search/results/?${params}`, {}, 5, 6000);
    const data = await res.json();
    total = data.total_count ?? total;
    const rows = parseRows(data.results_html ?? "");
    if (rows.length === 0) break;
    for (const g of rows) games.set(g.appid, g);
    console.log(`Recherche : ${games.size} jeux (start=${start}/${total})`);
    start += PAGE; pages++;
    await sleep(SEARCH_DELAY);
  }
  return { games, total: Number.isFinite(total) ? total : games.size };
}

// ---------- Étape 2 : page du jeu ----------
const pageUrl = (id) => `https://store.steampowered.com/app/${id}/?l=english&cc=fr`;
const pageOpts = { headers: { Cookie: COOKIE } };

function parsePage(html) {
  if (!/id="appHubAppName"/.test(html)) return null; // page absente / age gate / redirection
  const desc =
    /class="game_description_snippet">\s*([\s\S]*?)\s*<\/div>/.exec(html)?.[1] ??
    /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "";
  const langTable = /<table class="game_language_options">([\s\S]*?)<\/table>/.exec(html)?.[1] ?? "";
  const links = (s) => all(s, /<a[^>]*>([^<]+)<\/a>/g);
  const devs = links(/id="developers_list"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "");
  const pubs = links(/<b>Publisher:<\/b>[\s\S]*?<div class="summary column">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "");
  const site = /linkfilter\/\?u=([^"&]+)[^>]*>\s*Visit the website/.exec(html)?.[1];
  const shots = uniq(html.match(/https:\/\/[^"'\s]*\/ss_[0-9a-f]+\.(?:1920x1080|600x338)\.jpg/g) ?? []).slice(0, 4);
  return {
    fetched: nowIso(),
    title: decode(/<div id="appHubAppName"[^>]*>([^<]*)</.exec(html)?.[1] ?? ""),
    short_description: stripTags(desc),
    release_date: decode(/<div class="release_date">[\s\S]*?<div class="date">([^<]*)<\/div>/.exec(html)?.[1] ?? ""),
    developers: devs.length ? devs : all(html, /(?:developer\/[^"]*|search\/\?developer=[^"]*)"[^>]*>([^<]+)</g),
    publishers: pubs.length ? pubs : all(html, /(?:publisher\/[^"]*|search\/\?publisher=[^"]*)"[^>]*>([^<]+)</g),
    genres: all(html, /store\.steampowered\.com\/genre\/[^"]*"[^>]*>([^<]+)</g),
    tags: all(html, /class="app_tag"[^>]*>\s*([^<]+?)\s*</g).filter((t) => t !== "+"),
    categories: all(html, /class="game_area_details_specs_ctn"[^>]*>[\s\S]*?<div class="label">([^<]+)<\/div>/g),
    languages: all(langTable, /<tr[^>]*>\s*<td[^>]*>\s*([^<\s][^<]*?)\s*<\/td>/g),
    website: site ? decodeURIComponent(site) : "",
    screenshots: shots,
    trailer: /data-mp4-hd-source="([^"]+)"/.exec(html)?.[1] ?? /data-mp4-source="([^"]+)"/.exec(html)?.[1] ?? "",
  };
}

async function fetchPage(appid) {
  const res = await fetchRetry(pageUrl(appid), pageOpts, 6, 60000); // 429 => longue pause
  const parsed = parsePage(await res.text());
  return parsed ?? { unavailable: true, fetched: nowIso() };
}

// ---------- Test de vitesse ----------
async function speedTest() {
  console.log("=== TEST DE VITESSE ===");
  const { games, total } = await scrapeSearch(4);
  const ids = [...games.keys()];
  const phases = [1500, 800, 400, 200]; // pause en ms, de la plus lente à la plus rapide
  const PER = 40;                       // pages lues par phase
  const fields = ["title", "short_description", "release_date", "developers", "publishers",
    "genres", "tags", "categories", "languages", "website", "screenshots", "trailer"];
  let idx = 0, best = null;

  for (const delay of phases) {
    const st = { ok: 0, nopage: 0, s429: 0, err: 0, ms: 0, filled: Object.fromEntries(fields.map((f) => [f, 0])) };
    const t0 = Date.now();
    for (let k = 0; k < PER && idx < ids.length; k++, idx++) {
      const t = Date.now();
      let res;
      try { res = await fetch(pageUrl(ids[idx]), { ...pageOpts, headers: { "User-Agent": UA, "Accept-Language": "en", ...pageOpts.headers } }); }
      catch { st.err++; continue; }
      if (res.status === 429) { st.s429++; break; }
      if (!res.ok) { st.err++; continue; }
      const html = await res.text();
      st.ms += Date.now() - t;
      const p = parsePage(html);
      if (!p) { st.nopage++; }
      else {
        st.ok++;
        for (const f of fields) if (Array.isArray(p[f]) ? p[f].length : p[f]) st.filled[f]++;
      }
      await sleep(delay);
    }
    const secs = (Date.now() - t0) / 1000;
    const n = st.ok + st.nopage;
    console.log(`\n--- Pause ${delay} ms ---`);
    console.log(`pages lues: ${n} | pages vides/gate: ${st.nopage} | erreurs: ${st.err} | 429: ${st.s429}`);
    console.log(`temps moyen par page: ${n ? Math.round(st.ms / n) : "?"} ms | débit: ${(n / secs).toFixed(2)} pages/s`);
    if (st.ok) console.log("champs remplis: " + fields.map((f) => `${f} ${Math.round((100 * st.filled[f]) / st.ok)}%`).join(", "));
    if (st.s429) { console.log(">> 429 (limite atteinte) : on arrête les tests ici."); break; }
    if (st.err > PER / 4) { console.log(">> Trop d'erreurs : on arrête ici."); break; }
    best = { delay, perPage: n ? st.ms / n : 0 };
  }

  console.log("\n=== RÉSUMÉ ===");
  if (!best) { console.log("Même la pause la plus lente (1500 ms) a échoué : Steam bloque probablement cette IP."); return; }
  const estMin = (total * (best.delay + best.perPage)) / 60000;
  console.log(`Plus petite pause sans 429 : ${best.delay} ms`);
  console.log(`Réglage conseillé : DELAY_MS=${Math.round(best.delay * 1.5)} (marge de sécurité x1.5)`);
  console.log(`Estimation du premier remplissage complet (${total} jeux) à ${best.delay} ms : ~${Math.round(estMin)} min (~${(estMin / 60).toFixed(1)} h)`);
}

// ---------- Mode diagnostic : extraits de HTML pour réparer les regex ----------
async function dumpMode() {
  console.log("=== DIAGNOSTIC HTML ===");
  const { games } = await scrapeSearch(1);
  const keys = ["developers_list", "Publisher:", "game_language_options", "Languages", "ss_",
    "mp4", "webm", "hls", "highlight_player_item", "Visit the website"];
  for (const id of [...games.keys()].slice(0, 3)) {
    const res = await fetch(pageUrl(id), { ...pageOpts, headers: { "User-Agent": UA, "Accept-Language": "en", ...pageOpts.headers } });
    const html = await res.text();
    console.log(`\n##### appid ${id} (${html.length} octets, HTTP ${res.status})`);
    for (const k of keys) {
      const i = html.indexOf(k);
      console.log(`[${k}] ` + (i < 0 ? "ABSENT" : JSON.stringify(html.slice(Math.max(0, i - 120), i + 350))));
    }
    await sleep(1500);
  }
}

// ---------- Programme principal ----------
if (DUMP) {
  await dumpMode();
  process.exit(0);
}
if (TEST) {
  await speedTest();
  process.exit(0);
}

const { games: list } = await scrapeSearch();
if (list.size === 0) {
  console.error("Aucun jeu récupéré : le format de la recherche a peut-être changé.");
  process.exit(1);
}

const cache = existsSync("details.json") ? JSON.parse(readFileSync("details.json", "utf8")) : {};
for (const id of Object.keys(cache)) if (!list.has(Number(id))) delete cache[id]; // jeux sortis

const ageDays = (c) => (Date.now() - Date.parse(c.fetched)) / 86400000;
const needsWork = (id) => {
  const c = cache[id];
  if (!c) return true;
  return ageDays(c) > (c.unavailable ? 7 : STALE_DAYS);
};
// Nouveaux d'abord, puis les fiches les plus anciennes
const queue = [...list.keys()]
  .filter(needsWork)
  .sort((a, b) => (cache[a] ? Date.parse(cache[a].fetched) : 0) - (cache[b] ? Date.parse(cache[b].fetched) : 0));

console.log(`${list.size} jeux, ${queue.length} fiches à (re)lire, pause ${DELAY_MS} ms.`);

let done = 0, fails = 0, empty = 0;
for (const id of queue) {
  if (outOfTime()) { console.log("Budget de temps atteint, reprise au prochain run."); break; }
  try {
    const det = await fetchPage(id);
    cache[id] = det;
    fails = 0;
    empty = det.unavailable ? empty + 1 : 0;
    if (empty >= 30) { console.warn("30 pages vides d'affilée : format changé ou blocage ? arrêt propre."); break; }
  } catch (e) {
    console.warn(e.message);
    if (++fails >= 5) { console.warn("Trop d'échecs d'affilée (blocage ?), arrêt propre."); break; }
  }
  if (++done % 50 === 0) {
    writeFileSync("details.json", JSON.stringify(cache));
    console.log(`Fiches : ${done}/${queue.length}`);
  }
  await sleep(DELAY_MS);
}
writeFileSync("details.json", JSON.stringify(cache));

// ---------- Sorties ----------
const full = [...list.values()].map((g) => ({ ...g, details: cache[g.appid] ?? null }));
writeFileSync("upcoming.json", JSON.stringify(full));
writeFileSync("upcoming-light.json", JSON.stringify([...list.values()]));

const j = (a) => (Array.isArray(a) ? a.join("; ") : a ?? "");
const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const cols = ["appid", "name", "release_search", "release_page", "price", "platforms", "developers",
  "publishers", "genres", "categories", "tags", "languages", "short_description", "website", "url", "image"];
const rows = full.map((g) => {
  const d = g.details && !g.details.unavailable ? g.details : {};
  return [g.appid, g.name, g.release, d.release_date, g.price, j(g.platforms), j(d.developers),
    j(d.publishers), j(d.genres), j(d.categories), j(d.tags), j(d.languages),
    d.short_description, d.website, g.url, g.image].map(cell).join(",");
});
writeFileSync("upcoming.csv", cols.join(",") + "\n" + rows.join("\n"));

const enriched = full.filter((g) => g.details && !g.details.unavailable).length;
console.log(`Terminé : ${full.length} jeux, ${enriched} avec fiche détaillée.`);
