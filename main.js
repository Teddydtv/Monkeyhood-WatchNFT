const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const OWNED_PATH = path.join(app.getPath('userData'), 'owned-collections.json');
const AUTO_KEY_PATH = path.join(app.getPath('userData'), 'auto-key.json');
const AUTO_KEY_ENDPOINT = 'https://api.opensea.io/api/v2/auth/keys'; // OpenSea's official instant-key endpoint — no signup, free-tier, expires after 7 days
const AUTO_KEY_REFRESH_BUFFER_MS = 60 * 60 * 1000; // fetch a replacement an hour before actual expiry so a poll never runs into a dead key
const DEFAULT_CONFIG = {
  openseaApiKey: '',
  twitterBearer: '',
  useAutoKey: true,             // when true, the app auto-fetches and auto-renews a free OpenSea instant API key instead of using the manual key below
  pollMinutes: 15,
  floorMoveThresholdPct: 15,   // notify if floor price moves this % between polls
  volumeSpikeThresholdPct: 100 // notify if 1-day volume jumps this % between polls
};

// --- Auto-fetched OpenSea instant API key -------------------------------
// OpenSea exposes a public, unauthenticated endpoint that hands out a
// free-tier API key on the spot (600 read req/h, 30 write req/h), valid for
// 7 days: POST https://api.opensea.io/api/v2/auth/keys — see
// https://docs.opensea.io/reference/api-keys. This lets the app work for a
// new user with zero setup. The fetched key + its expiry are cached to disk
// (in the user's own app-data folder) and silently refreshed once they're
// close to expiring.

let autoKeyState = null; // { api_key, expires_at, ... } — lazily loaded from disk

function loadAutoKeyState() {
  if (autoKeyState) return autoKeyState;
  try {
    autoKeyState = JSON.parse(fs.readFileSync(AUTO_KEY_PATH, 'utf-8'));
  } catch (e) {
    autoKeyState = null;
  }
  return autoKeyState;
}

function saveAutoKeyState(data) {
  autoKeyState = data;
  try { fs.writeFileSync(AUTO_KEY_PATH, JSON.stringify(data, null, 2)); } catch (e) { /* non-fatal — key just won't be cached across restarts */ }
}

function autoKeyIsValid(state) {
  if (!state || !state.api_key || !state.expires_at) return false;
  const expiresMs = new Date(state.expires_at).getTime();
  if (Number.isNaN(expiresMs)) return false;
  return expiresMs - Date.now() > AUTO_KEY_REFRESH_BUFFER_MS;
}

async function fetchAutoKey() {
  const r = await fetch(AUTO_KEY_ENDPOINT, { method: 'POST' });
  if (!r.ok) throw new Error(`Auto key request failed: ${r.status} ${r.statusText}`);
  const d = await r.json();
  if (!d.api_key) throw new Error('Auto key response had no api_key field');
  saveAutoKeyState(d);
  return d;
}

async function ensureAutoKey() {
  const state = loadAutoKeyState();
  if (autoKeyIsValid(state)) return state.api_key;
  const fresh = await fetchAutoKey(); // throws on network/API failure — caller decides fallback
  return fresh.api_key;
}

// Resolves the API key actually used for requests: the auto-fetched/renewed
// OpenSea instant key when "auto key" is enabled, otherwise the
// manually-entered key from Settings. Falls back to a manual key (if any)
// when an auto-fetch attempt fails, so a transient network hiccup doesn't
// stall polling for someone who also has a personal key saved.
async function resolveApiKey(cfg) {
  if (cfg.useAutoKey !== false) {
    try {
      return await ensureAutoKey();
    } catch (e) {
      if (cfg.openseaApiKey) return cfg.openseaApiKey;
      throw e;
    }
  }
  return cfg.openseaApiKey || '';
}

let win = null;
let tray = null;
let pollTimer = null;
let lastSnapshot = {}; // slug -> { floor, vol1d }
let alertsState = {};  // slug -> { name, direction, detail, tweetUrl, noMoveCount }
let floorHistory = {}; // slug -> [{ t, floor }, ...] — used to derive a rolling 24h floor high, since OpenSea's stats endpoint doesn't expose this directly
let ownedSlugs = new Set(); // user-curated watchlist, toggled via right-click
let lastResultsCache = []; // most recent poll's collection results, reused to re-bucket instantly on owned add/remove
let isQuitting = false;
const NO_MOVE_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function loadOwned() {
  try {
    ownedSlugs = new Set(JSON.parse(fs.readFileSync(OWNED_PATH, 'utf-8')));
  } catch (e) {
    ownedSlugs = new Set();
  }
}

function saveOwned() {
  fs.writeFileSync(OWNED_PATH, JSON.stringify([...ownedSlugs]));
}

function broadcastCollections(results) {
  const owned = results.filter(c => ownedSlugs.has(c.slug)).map(c => ({ ...c, showVerifiedTag: true }));
  sendToRenderer('collections-update', {
    owned,
    verified: results.filter(c => c.verified),
    unverified: results.filter(c => !c.verified)
  });
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

async function fetchJson(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  return r.json();
}

async function fetchEthPrice() {
  try {
    const d = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true');
    return { price: d.ethereum.usd, change24h: d.ethereum.usd_24h_change };
  } catch (e) {
    return null;
  }
}

async function fetchCollectionsList(apiKey) {
  const d = await fetchJson('https://api.opensea.io/api/v2/collections?chain=robinhood&order_by=seven_day_volume&limit=20', {
    'x-api-key': apiKey, accept: 'application/json'
  });
  return d.collections || [];
}

async function fetchCollectionStats(slug, apiKey) {
  const d = await fetchJson(`https://api.opensea.io/api/v2/collections/${slug}/stats`, {
    'x-api-key': apiKey, accept: 'application/json'
  });
  return d;
}

async function fetchCollectionDetail(slug, apiKey) {
  const d = await fetchJson(`https://api.opensea.io/api/v2/collections/${slug}`, {
    'x-api-key': apiKey, accept: 'application/json'
  });
  return d;
}

async function fetchTwitterHandleFromOpenSeaPage(slug) {
  try {
    const r = await fetch(`https://opensea.io/collection/${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!r.ok) return null;
    const html = await r.text();
    const matches = [...html.matchAll(/https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})/gi)];
    const exclude = new Set(['intent', 'share', 'opensea', 'home', 'i', 'search', 'hashtag', 'login', 'signup']);
    for (const m of matches) {
      const handle = m[1];
      if (!exclude.has(handle.toLowerCase())) return handle;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function findTwitterHandle(slug, apiKey) {
  // prefer scraping the live OpenSea collection page — it's what's actually displayed to users
  const scraped = await fetchTwitterHandleFromOpenSeaPage(slug);
  if (scraped) return scraped;
  // fall back to the API's own field in case the page structure changes or blocks the request
  try {
    const detailObj = await fetchCollectionDetail(slug, apiKey);
    return detailObj?.twitter_username || detailObj?.socials?.twitter || null;
  } catch (e) {
    return null;
  }
}

async function fetchSalesLastHour(slug, apiKey) {
  const afterUnix = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
  const CAP = 250;
  const PAGE_SIZE = 50;
  let count = 0;
  let cursor = null;
  for (let i = 0; i < CAP / PAGE_SIZE; i++) {
    let url = `https://api.opensea.io/api/v2/events/collection/${slug}?event_type=sale&after=${afterUnix}&limit=${PAGE_SIZE}`;
    if (cursor) url += `&next=${encodeURIComponent(cursor)}`;
    const d = await fetchJson(url, { 'x-api-key': apiKey, accept: 'application/json' });
    const rawEvents = d.asset_events || d.events || [];
    // defensive filter: only count events that are actual completed sales, never bids/offers/listings/cancellations,
    // in case the API's event_type query param doesn't hold across paginated ("next") requests
    const realSales = rawEvents.filter(e => (e.event_type || e.eventType) === 'sale');
    count += realSales.length;
    cursor = d.next || null;
    if (!cursor || rawEvents.length < PAGE_SIZE) break; // last page reached
  }
  return { count, capped: count >= CAP };
}

async function fetchTopCollectionOffer(slug, apiKey) {
  // OpenSea's docs don't publish a full example response for this endpoint, so the price is pulled
  // defensively from the shapes their offer/order objects have historically used. Results are already
  // sorted by best price server-side, so the first entry (if any) is the top offer.
  const d = await fetchJson(`https://api.opensea.io/api/v2/offers/collection/${slug}?limit=1`, {
    'x-api-key': apiKey, accept: 'application/json'
  });
  const offers = d.offers || d.orders || [];
  if (!offers.length) return null;
  const o = offers[0];

  const rawValue =
    o?.price?.value ??
    o?.protocol_data?.parameters?.offer?.[0]?.startAmount ??
    o?.current_price ??
    null;
  if (rawValue == null) return null;

  const decimals = o?.price?.decimals ?? 18; // collection offers are near-universally WETH (18 decimals)
  const amount = Number(rawValue) / Math.pow(10, decimals);
  return Number.isFinite(amount) ? amount : null;
}

async function checkRecentTweet(username, bearer) {
  if (!username) return { status: 'no_handle', url: null };
  if (!bearer) {
    // no API token — best we can do is link straight to the profile, which shows their latest tweet
    return { status: 'profile_link', url: `https://twitter.com/${username}` };
  }
  try {
    const userRes = await fetchJson(`https://api.twitter.com/2/users/by/username/${username}`, {
      Authorization: `Bearer ${bearer}`
    });
    const userId = userRes.data && userRes.data.id;
    if (!userId) return { status: 'no_user', url: `https://twitter.com/${username}` };
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const tweets = await fetchJson(
      `https://api.twitter.com/2/users/${userId}/tweets?max_results=5&start_time=${since}`,
      { Authorization: `Bearer ${bearer}` }
    );
    if (tweets.data && tweets.data.length > 0) {
      const t = tweets.data[0];
      return { status: 'found', url: `https://twitter.com/${username}/status/${t.id}` };
    }
    return { status: 'no_recent_tweet', url: `https://twitter.com/${username}` };
  } catch (e) {
    return { status: 'api_error', url: `https://twitter.com/${username}`, error: e.message };
  }
}

function notify(title, body, url) {
  const n = new Notification({ title, body, silent: false });
  if (url) {
    n.on('click', () => shell.openExternal(url));
  }
  n.show();
}

function slugify(s) {
  return s.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
}

async function resolveCollectionFromQuery(query, cfg) {
  const q = (query || '').trim();
  if (!q) return { status: 'empty' };

  // 1. already-tracked collection matching by name or slug — no extra API call needed
  const localMatch = lastResultsCache.find(
    c => c.name.toLowerCase().includes(q.toLowerCase()) || c.slug.toLowerCase() === slugify(q)
  );
  if (localMatch) return { status: 'found', slug: localMatch.slug, name: localMatch.name };

  // 2. a pasted OpenSea collection URL — pull the slug straight out of it
  const urlMatch = q.match(/opensea\.io\/collection\/([a-zA-Z0-9_-]+)/i);
  const candidates = urlMatch ? [urlMatch[1]] : [slugify(q)];

  for (const candidate of candidates) {
    try {
      const detail = await fetchCollectionDetail(candidate, cfg.openseaApiKey);
      if (detail) return { status: 'found', slug: candidate, name: detail.name || candidate };
    } catch (e) { /* try next candidate, or fall through to not_found */ }
  }

  return { status: 'not_found', query: q };
}

async function pollOnce() {
  const cfg = loadConfig();
  try {
    cfg.openseaApiKey = await resolveApiKey(cfg);
  } catch (e) {
    sendToRenderer('collections-error', `Couldn't get an OpenSea API key automatically (${e.message}). Add your own key in Settings, or try again shortly.`);
    return;
  }
  const eth = await fetchEthPrice();
  sendToRenderer('eth-update', eth);
  const ethUsd = eth ? eth.price : null;

  const toUsd = (ethAmount) => {
    if (ethAmount == null) return null;
    if (!ethUsd) return ethAmount.toFixed(4) + ' ETH'; // fallback if price fetch failed
    return '$' + (ethAmount * ethUsd).toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  if (!cfg.openseaApiKey) {
    sendToRenderer('collections-error', 'No OpenSea API key set yet.');
    return;
  }

  let collections;
  try {
    collections = await fetchCollectionsList(cfg.openseaApiKey);
  } catch (e) {
    sendToRenderer('collections-error', e.message);
    return;
  }

  // owned collections outside the top-20-by-volume feed still need to be polled, or they'd show stale/blank data forever
  const trackedSlugs = new Set(collections.map(c => c.collection || c.slug));
  const missingOwned = [...ownedSlugs].filter(s => !trackedSlugs.has(s));
  for (const slug of missingOwned) {
    try {
      const detail = await fetchCollectionDetail(slug, cfg.openseaApiKey);
      collections.push({
        collection: slug,
        name: detail.name || slug,
        safelist_status: detail.safelist_status || 'not_requested'
      });
    } catch (e) { /* collection may have been mistyped/removed — it'll just be skipped this poll */ }
  }

  const results = [];
  const touchedThisPoll = new Set();

  for (const c of collections) {
    const slug = c.collection || c.slug;
    if (!slug) continue;
    try {
      const stats = await fetchCollectionStats(slug, cfg.openseaApiKey);
      const floor = stats?.total?.floor_price ?? null;
      const vol1d = stats?.intervals?.find(i => i.interval === 'one_day')?.volume ?? null;
      const sales1d = stats?.intervals?.find(i => i.interval === 'one_day')?.sales ?? null;
      const totalSales = stats?.total?.sales ?? 0;
      const owners = stats?.total?.num_owners ?? null;

      let salesLastHour = null;
      try {
        salesLastHour = await fetchSalesLastHour(slug, cfg.openseaApiKey);
      } catch (e) { /* rate limit or transient error — leave as null, shown as n/a */ }

      let totalSupply = null;
      try {
        const detail = await fetchCollectionDetail(slug, cfg.openseaApiKey);
        totalSupply = detail?.total_supply ?? detail?.stats?.total_supply ?? null;
      } catch (e) { /* leave as null, shown as n/a */ }

      let topOffer = null;
      try {
        topOffer = await fetchTopCollectionOffer(slug, cfg.openseaApiKey);
      } catch (e) { /* leave as null, shown as n/a */ }

      const prev = lastSnapshot[slug];
      let moved = false;

      if (prev) {
        if (prev.floor && floor && Math.abs(floor - prev.floor) / prev.floor * 100 >= cfg.floorMoveThresholdPct) {
          const direction = floor > prev.floor ? 'up' : 'down';
          const pct = ((floor - prev.floor) / prev.floor) * 100;
          await handleBigMove(c.name || slug, slug, cfg, direction, `Floor moved ${pct.toFixed(1)}% to ${toUsd(floor)}`);
          moved = true;
        }
        if (prev.vol1d && vol1d && (vol1d - prev.vol1d) / prev.vol1d * 100 >= cfg.volumeSpikeThresholdPct) {
          await handleBigMove(c.name || slug, slug, cfg, 'up', `1-day volume spiked ${(((vol1d - prev.vol1d) / prev.vol1d) * 100).toFixed(0)}% to ${toUsd(vol1d)}`);
          moved = true;
        }
      }

      const salesLastHourNumRaw = salesLastHour ? salesLastHour.count : null;
      const trend = (curr, prevVal) => {
        if (curr == null || prevVal == null) return null;
        if (curr > prevVal) return 'up';
        if (curr < prevVal) return 'down';
        return 'same';
      };
      const floorTrend = prev ? trend(floor, prev.floor) : null;
      const ownersTrend = prev ? trend(owners, prev.owners) : null;
      const salesTrend = prev ? trend(salesLastHourNumRaw, prev.salesLastHourNum) : null;

      lastSnapshot[slug] = { floor, vol1d, owners, salesLastHourNum: salesLastHourNumRaw };

      let floor24hHigh = null;
      if (floor != null) {
        const now = Date.now();
        const hist = floorHistory[slug] || [];
        hist.push({ t: now, floor });
        floorHistory[slug] = hist.filter(h => now - h.t <= DAY_MS);
        floor24hHigh = Math.max(...floorHistory[slug].map(h => h.floor));
      }

      // track quiet checks for any collection currently showing an active alert
      if (alertsState[slug]) {
        touchedThisPoll.add(slug);
        if (!moved) {
          alertsState[slug].noMoveCount += 1;
          if (alertsState[slug].noMoveCount >= NO_MOVE_LIMIT) {
            delete alertsState[slug];
          }
        }
      }

      results.push({
        name: c.name || slug,
        slug,
        verified: c.safelist_status === 'verified',
        floor: floor != null ? toUsd(floor) : 'n/a',
        floor24hHigh: floor24hHigh != null ? toUsd(floor24hHigh) : 'n/a',
        owners: owners != null ? owners.toLocaleString() : 'n/a',
        vol1d: vol1d != null ? toUsd(vol1d) + ' (24h)' : '',
        totalSales,
        sales1d: sales1d ?? 0,
        salesLastHourNum: salesLastHour ? salesLastHour.count : -1,
        salesLastHour: salesLastHour ? (salesLastHour.capped ? '250+' : String(salesLastHour.count)) : 'n/a',
        size: totalSupply != null ? totalSupply.toLocaleString() : 'n/a',
        topOffer: topOffer != null ? toUsd(topOffer) : 'n/a',
        floorTrend,
        ownersTrend,
        salesTrend
      });
    } catch (e) {
      results.push({ name: c.name || slug, slug, verified: c.safelist_status === 'verified', floor: 'n/a', floor24hHigh: 'n/a', owners: 'n/a', vol1d: '', totalSales: 0, sales1d: 0, salesLastHourNum: -1, salesLastHour: 'n/a', size: 'n/a', topOffer: 'n/a', floorTrend: null, ownersTrend: null, salesTrend: null });
    }
  }

  // most sales in the last hour floats to the top, within each verified/unverified group (renderer also sorts, this keeps payload pre-sorted)
  results.sort((a, b) => (b.salesLastHourNum - a.salesLastHourNum) || (b.sales1d - a.sales1d) || (b.totalSales - a.totalSales));

  lastResultsCache = results;
  broadcastCollections(results);
  sendToRenderer('alerts-update', Object.entries(alertsState).map(([slug, a]) => ({ slug, ...a })));
}

async function handleBigMove(name, slug, cfg, direction, detail) {
  let tweetUrl = null;
  let tweetStatus = 'no_handle';
  try {
    const handle = await findTwitterHandle(slug, cfg.openseaApiKey);
    const result = await checkRecentTweet(handle, cfg.twitterBearer);
    tweetUrl = result.url;
    tweetStatus = result.status;
  } catch (e) {
    tweetStatus = 'lookup_error';
  }

  const openseaUrl = `https://opensea.io/collection/${slug}`;
  const tweetStatusText = {
    no_handle: 'no X/Twitter account found on the OpenSea collection page',
    no_user: 'X account not found',
    no_recent_tweet: 'no tweet in the last 2 hours — linking to profile instead',
    profile_link: 'linking to their profile (add an X API token in Settings to jump to the exact latest tweet)',
    api_error: 'X API error — linking to profile instead',
    lookup_error: 'could not look up X account',
    found: 'latest tweet found'
  }[tweetStatus] || tweetStatus;

  const clickUrl = tweetUrl || openseaUrl;
  const body = tweetUrl
    ? `${detail}\n${tweetStatusText}. Click to open.`
    : `${detail}\nNo tweet link available (${tweetStatusText}). Click to open the collection on OpenSea.`;

  notify(`Big move: ${name}`, body, clickUrl);

  alertsState[slug] = {
    name,
    direction,
    detail,
    tweetUrl,
    tweetStatusText,
    openseaUrl,
    clickUrl,
    noMoveCount: 0
  };
}

let isWatcherRunning = false;

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const cfg = loadConfig();
  isWatcherRunning = true;
  sendToRenderer('watcher-status', { running: true });
  pollOnce();
  pollTimer = setInterval(pollOnce, Math.max(1, cfg.pollMinutes) * 60 * 1000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  isWatcherRunning = false;
  sendToRenderer('watcher-status', { running: false });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'trayicon.png'));
  tray.setToolTip('Robinhood Chain — NFT Watch (running in background)');
  const menu = Menu.buildFromTemplate([
    { label: 'Open dashboard', click: () => { if (win) { win.show(); } } },
    { label: 'Check now', click: () => pollOnce() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { if (win) win.show(); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 780,
    backgroundColor: '#101a14',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.loadFile('index.html');

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId('Robinhood Chain NFT Watch');
  loadOwned();
  createWindow();
  createTray();
  startPolling();
});

app.on('window-all-closed', () => {
  // keep running in background/tray on Windows instead of quitting
});

app.on('before-quit', () => { isQuitting = true; });

ipcMain.handle('get-settings', () => {
  const cfg = loadConfig();
  const state = loadAutoKeyState();
  // autoKeyActive/autoKeyExpiresAt are informational only — never written back to config.json by save-settings
  return { ...cfg, autoKeyActive: autoKeyIsValid(state), autoKeyExpiresAt: state && state.expires_at ? state.expires_at : null };
});
ipcMain.handle('save-settings', (evt, cfg) => {
  saveConfig({ ...loadConfig(), ...cfg });
  return loadConfig();
});
ipcMain.handle('get-watcher-status', () => ({ running: isWatcherRunning }));
ipcMain.handle('start-watcher', () => {
  startPolling();
  return { running: true };
});
ipcMain.handle('stop-watcher', () => {
  stopPolling();
  return { running: false };
});
ipcMain.handle('exit-app', () => {
  isQuitting = true;
  app.quit();
});
ipcMain.handle('poll-now', () => pollOnce());
ipcMain.handle('dismiss-alert', (evt, slug) => {
  delete alertsState[slug];
  sendToRenderer('alerts-update', Object.entries(alertsState).map(([s, a]) => ({ slug: s, ...a })));
  return true;
});
ipcMain.handle('add-owned', (evt, slug) => {
  ownedSlugs.add(slug);
  saveOwned();
  broadcastCollections(lastResultsCache);
  return true;
});
ipcMain.handle('remove-owned', (evt, slug) => {
  ownedSlugs.delete(slug);
  saveOwned();
  broadcastCollections(lastResultsCache);
  return true;
});
ipcMain.handle('search-add-collection', async (evt, query) => {
  const cfg = loadConfig();
  try {
    cfg.openseaApiKey = await resolveApiKey(cfg);
  } catch (e) {
    return { status: 'no_api_key' };
  }
  if (!cfg.openseaApiKey) return { status: 'no_api_key' };
  const result = await resolveCollectionFromQuery(query, cfg);
  if (result.status !== 'found') return result;
  ownedSlugs.add(result.slug);
  saveOwned();
  await pollOnce(); // refreshes all columns, including full stats for the newly added collection
  return result;
});
