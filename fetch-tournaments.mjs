#!/usr/bin/env node
/*
 * Log Pose — tournament data pipeline
 * --------------------------------------------------------------------------
 * Pulls One Piece tournament results + decklists from the Limitless API,
 * classifies each event into a tier (Regionals / Nationals / etc.), keeps only
 * name + country (no extra PII), and writes a `tournaments.json` file in the
 * SAME shape the app already consumes (so it's a drop-in replacement for the
 * current DecksDb feed — you just point the app's DECKS_URLS at the new file).
 *
 * Runs server-side (GitHub Actions / your machine) — NOT in the browser — so
 * there are no CORS issues and the API key (if any) stays secret.
 *
 * Node 18+ (uses built-in fetch). No npm install needed.
 *
 * Usage:
 *   node fetch-tournaments.mjs            # build tournaments.json
 *   node fetch-tournaments.mjs --probe    # print ONE event's raw decklist JSON
 *                                          # (run this FIRST to confirm shape)
 *
 * Optional env:
 *   LIMITLESS_KEY   API key for higher rate limits (apply at limitlesstcg).
 * --------------------------------------------------------------------------
 */

const API = "https://play.limitlesstcg.com/api";
const GAME = "OP";                 // One Piece
const MAX_TOURNAMENTS = 120;       // how many recent events to scan
const TOP_CUT = 8;                 // keep decklists placing 1..TOP_CUT
const MIN_DATE = "2026-01-01";     // only keep events on/after this date (current meta)
// NOTE: Egman Events runs its tournaments ON Limitless (listed as organizer
// "The Egman"), so this single API already includes egmanevents' 2026 Regionals,
// Treasure Cups, Worlds, etc. — no separate scrape of egmanevents.com needed.
const OUT = new URL("./tournaments.json", import.meta.url);
const KEY = process.env.LIMITLESS_KEY || "";

// Official image URL is predictable from the card number. The app already
// proxies these for reliability, so just hand it the canonical URL.
const imgFor = (num) =>
  `https://en.onepiece-cardgame.com/images/cardlist/card/${num}.png`;

// --- tiny fetch helper: polite, retries once, supports optional key ---------
async function api(path) {
  const url = `${API}${path}${path.includes("?") ? "&" : "?"}${KEY ? `key=${KEY}` : ""}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: KEY ? { "X-Access-Key": KEY } : {},
    });
    if (res.status === 429) {           // rate limited — back off and retry
      const wait = Number(res.headers.get("retry-after") || 3) * 1000;
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${path} -> rate limited twice`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- TIER CLASSIFICATION ----------------------------------------------------
// Limitless has no "Regional/National" field, so we derive it. Most reliable
// signal is the organizer; maintain this small allow-list as you learn the
// official organizer IDs/names. Player count + name keywords are fallbacks.
const OFFICIAL_ORGANIZERS = {
  // organizerId: "Tier"   <-- fill in as you identify sanctioned organizers
  // 123: "Regionals",
  // 456: "Nationals",
};
function classifyTier(details) {
  if (OFFICIAL_ORGANIZERS[details?.organizer?.id])
    return OFFICIAL_ORGANIZERS[details.organizer.id];
  const name = `${details?.name || ""}`.toLowerCase();
  if (/world|worlds/.test(name)) return "Worlds";
  if (/national|nationals/.test(name)) return "Nationals";
  if (/region|regional/.test(name)) return "Regionals";
  if (/champ|championship/.test(name)) return "Championships";
  if (details?.isOnline) return "Online";
  const p = details?.players || 0;
  if (p >= 256) return "Regionals";      // heuristic — tune to your scene
  if (p >= 64) return "Locals / Store";
  return "Locals / Store";
}

function ordinal(n) {
  if (n === 1) return "1st Place";
  if (n === 2) return "2nd Place";
  if (n === 3) return "3rd Place";
  if (n <= TOP_CUT) return `Top ${TOP_CUT}`;
  return `${n}th`;
}

// --- DECKLIST PARSING -------------------------------------------------------
// The `standings[].decklist` shape is game-specific and I could not confirm
// the One Piece shape from here (the API blocks non-browser probes). Run
// `--probe` first, look at the printed JSON, and adjust this function. It
// already tries the most likely shapes and returns [{Qty, cardnum, Img}].
function parseDecklist(dl) {
  if (!dl) return [];
  const out = [];
  const push = (num, qty) => {
    if (!num) return;
    num = String(num).toUpperCase().replace(/\s+/g, "");
    out.push({ Qty: Number(qty) || 1, cardnum: num, Img: imgFor(num) });
  };
  // shape A: flat array of card entries
  const fromItem = (it) => {
    if (!it || typeof it !== "object") return;
    const qty = it.count ?? it.quantity ?? it.qty ?? it.amount ?? 1;
    // a full card code, or set + number that we join
    const num =
      it.cardnum || it.card || it.id || it.cardId || it.code ||
      (it.set && (it.number ?? it.num) != null ? `${it.set}-${it.number ?? it.num}` : null);
    push(num, qty);
  };
  if (Array.isArray(dl)) { dl.forEach(fromItem); return out; }
  if (typeof dl === "object") {
    // shape B: { leader, character:[], event:[], stage:[], don:[] } or similar
    if (dl.leader) fromItem(typeof dl.leader === "object" ? dl.leader : { card: dl.leader, count: 1 });
    for (const k of Object.keys(dl)) {
      if (Array.isArray(dl[k])) dl[k].forEach(fromItem);
    }
    return out;
  }
  return out;
}

// pick the leader card number from a parsed list (cards numbered like XXX-001
// that the catalog flags as Leader; without the catalog here we keep all cards
// and let the APP detect the leader — same as it does for the current feed).
async function build() {
  console.log("Fetching recent One Piece tournaments…");
  const tournaments = await api(`/tournaments?game=${GAME}&limit=${MAX_TOURNAMENTS}`);
  const decks = [];

  for (const t of tournaments) {
    try {
      if (t.date && String(t.date).slice(0, 10) < MIN_DATE) continue; // 2026+ only
      const details = await api(`/tournaments/${t.id}/details`);
      if (!details.decklists || details.isPublic === false) continue; // no lists -> skip
      const tier = classifyTier(details);
      const standings = await api(`/tournaments/${t.id}/standings`);
      const top = standings
        .filter((s) => s.placing && s.placing <= TOP_CUT && s.decklist)
        .sort((a, b) => a.placing - b.placing);

      for (const s of top) {
        const cards = parseDecklist(s.decklist);
        if (!cards.length) continue;
        decks.push({
          DeckName: `${(s.deck && s.deck.name) || "Deck"} — ${ordinal(s.placing)}`,
          Author: s.name || "",             // display name only
          Country: s.country || "",         // ISO-2 only — no other PII
          Tournament: details.name || "",
          Tier: tier,                        // <-- the app reads this for the drill-down
          Host: (details.organizer && details.organizer.name) || "",
          Placement: ordinal(s.placing),
          Date: details.date || "",
          DeckColor: "",                     // app derives color from the leader card
          Cards: cards,
        });
      }
      await sleep(400); // be polite to the API
      console.log(`  ${details.name} [${tier}] — kept ${top.length} lists`);
    } catch (e) {
      console.warn(`  skipped ${t.id}: ${e.message}`);
    }
  }

  const { writeFileSync } = await import("node:fs");
  writeFileSync(OUT, JSON.stringify({ Decks: decks, generatedAt: Date.now() }, null, 0));
  console.log(`\nWrote ${decks.length} decklists to tournaments.json`);
}

// --- probe mode: confirm the decklist shape before trusting parseDecklist ---
async function probe() {
  const tournaments = await api(`/tournaments?game=${GAME}&limit=10`);
  for (const t of tournaments) {
    const details = await api(`/tournaments/${t.id}/details`);
    if (!details.decklists) continue;
    const standings = await api(`/tournaments/${t.id}/standings`);
    const withList = standings.find((s) => s.decklist);
    if (!withList) continue;
    console.log("Tournament:", details.name, "| players:", details.players, "| online:", details.isOnline);
    console.log("Sample standing (name/country/placing):", withList.name, withList.country, withList.placing);
    console.log("RAW decklist JSON shape:\n", JSON.stringify(withList.decklist, null, 2));
    return;
  }
  console.log("No public tournament with decklists found in the latest 10.");
}

const mode = process.argv[2];
(mode === "--probe" ? probe() : build()).catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
