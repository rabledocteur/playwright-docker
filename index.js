// index.js (CommonJS)
require('dotenv').config();

const express = require('express');
const { chromium } = require('playwright');
const { createClient } = require('@supabase/supabase-js');

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 3000);
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() === 'true';
const SMOKE_URL = process.env.SMOKE_URL || 'https://example.com/';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const TTK_PLATFORM = (process.env.TTK_PLATFORM || 'tiktok').toLowerCase();
const TTK_ACCOUNT = process.env.TTK_ACCOUNT || ''; // ex: rab.le.dr.numerique

const hasSupabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY;
const supabase = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

// ---------- EXPRESS ----------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.get('/health', (_req, res) => res.status(200).send('ok'));

// ---------- UTILS COOKIES ----------
const TTK_BASE_URL = 'https://www.tiktok.com/'; // slash final

const mapSameSite = (v) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).toLowerCase();
  if (s === 'lax') return 'Lax';
  if (s === 'strict') return 'Strict';
  if (s === 'no_restriction' || s === 'none') return 'None';
  return undefined;
};

// Cookie-Editor -> Playwright Cookies (basés sur url)
const toPlaywrightCookiesStrict = (raw = []) =>
  raw
    .filter((c) => c && typeof c.name === 'string' && c.name.length > 0 && c.value !== undefined)
    .map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value ?? ''),
        url: TTK_BASE_URL, // évite les soucis domain/path
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      };
      const ss = mapSameSite(c.sameSite);
      if (ss) out.sameSite = ss;
      if (ss === 'None') out.secure = true; // règle web
      let exp = Number(c.expirationDate ?? c.expiry);
      if (Number.isFinite(exp) && exp > 0) {
        if (exp > 1e12) exp = Math.floor(exp / 1000); // ms -> s si nécessaire
        out.expires = Math.floor(exp);
      }
      return out;
    });

const cookieFlags = (list = []) => {
  const names = new Set(list.map((c) => c.name));
  const has = (n) => names.has(n);
  return {
    has_sessionid: has('sessionid'),
    has_sessionid_ss: has('sessionid_ss'),
    has_sid_tt: has('sid_tt'),
    has_sid_ucp_v1: has('sid_ucp_v1'),
    has_ssid_ucp_v1: has('ssid_ucp_v1'),
    has_msToken: has('msToken'),
    has_ttwid: has('ttwid'),
    has_tt_chain_token: has('tt_chain_token'),
    has_tt_csrf_token: has('tt_csrf_token'),
  };
};

// ---------- SUPABASE ----------
async function upsertSession({ platform, account, cookies, user_agent }) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!Array.isArray(cookies)) throw new Error('cookies must be an array');
  const row = { platform, account, cookies, user_agent: user_agent || null };
  const { data, error } = await supabase
    .from('tiktok_sessions')
    .upsert(row, { onConflict: 'platform,account' })
    .select()
    .limit(1);
  if (error) throw error;
  return data && data[0];
}

async function loadSession(platform, account) {
  if (!supabase) throw new Error('Supabase not configured');
  const { data, error } = await supabase
    .from('tiktok_sessions')
    .select('cookies,user_agent')
    .eq('platform', platform)
    .eq('account', account)
    .order('id', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

// ---------- AUTH: ENREGISTRE LES COOKIES ----------
app.post('/auth/set-cookies', async (req, res) => {
  try {
    const platform = (req.body.platform || TTK_PLATFORM || 'tiktok').toLowerCase();
    const account = req.body.account || TTK_ACCOUNT;
    const cookies = req.body.cookies;
    if (!Array.isArray(cookies)) return res.status(400).json({ ok: false, error: 'Body must include "cookies": []' });
    if (!account) return res.status(400).json({ ok: false, error: 'Missing "account"' });

    const saved = await upsertSession({
      platform, account, cookies,
      user_agent: req.body.user_agent || req.headers['user-agent'] || null,
    });

    res.json({ ok: true, platform, account, saved: cookies.length, flags: cookieFlags(cookies), rowId: saved?.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ===================== HELPERS TIKTOK =====================

// ferme les overlays TUX si présents
async function closeOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const hasOverlay = await page.locator('div[class*="TUXModal-overlay"], div[data-tux-overlay], [data-floating-portal="true"]').first().isVisible().catch(() => false);
    if (!hasOverlay) break;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }
}

// ouvre l’onglet “Commentaires” (FR/EN) et scrolle dans le bon conteneur
async function openCommentsPanel(page) {
  // s’assure qu’on est bien sur la page vidéo
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });

  // activer l’onglet commentaires
  const commentTabCandidates = [
    'button:has-text("Commentaires")',
    'div[role="tab"]:has-text("Commentaires")',
    'button:has-text("Comments")',
    'div[role="tab"]:has-text("Comments")',
  ];
  for (const sel of commentTabCandidates) {
    const el = page.locator(sel).first();
    if (await el.count() && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 5000 }).catch(() => {});
      break;
    }
  }

  // conteneurs possibles des items de commentaires
  const panelCandidates = [
    'div[class*="DivCommentContainer"]',
    'div[class*="DivCommentList"]',
    'div[data-e2e="comment-list"]',
    'div[class*="DivRightContainer"] div:has([data-e2e*="comment"])',
  ];

  let panel = null;
  for (const sel of panelCandidates) {
    const loc = page.locator(sel).first();
    if (await loc.count()) { panel = loc; break; }
  }
  if (!panel) panel = page.locator('body');

  // charger du contenu via scroll
  for (let i = 0; i < 6; i++) {
    await panel.evaluate((el) => { el.scrollBy?.(0, 1200); }, {}).catch(() => {});
    await page.waitForTimeout(350);
  }
  await closeOverlays(page);
}

// essaie plusieurs variantes de sélecteurs et retourne celles qui “matchent”
async function discoverSelectors(page) {
  const candidates = {
    item: [
      '[data-e2e="comment-item"]',
      '[data-e2e^="comment-item"]',
      'li[class*="CommentItem"]',
      'div[class*="DivCommentObject"]',
    ],
    user: [
      '[data-e2e="comment-username"]',
      '[data-e2e^="comment-username"]',
      '[data-e2e="comment-user-name"]',
      '[data-e2e^="comment-user"]',
      'a[href^="/@"]',
    ],
    text: [
      '[data-e2e="comment-content"]',
      '[data-e2e^="comment-text"]',
      '[data-e2e^="comment-level"]', // ex: comment-level-1
      'span[class*="CommentSubContent"]',
      'p[class*="StyledTUXText"] + span', // fallback
    ],
    reply: [
      '[data-e2e="comment-reply"]',
      'button:has-text("Répondre")',
      'button:has-text("Reply")',
      'a:has-text("Répondre")',
      'a:has-text("Reply")',
    ],
  };

  const pickFirstWorking = async (list) => {
    for (const sel of list) {
      const n = await page.locator(sel).count().catch(() => 0);
      if (n > 0) return sel;
    }
    return null;
  };

  const item = await pickFirstWorking(candidates.item);
  const user = await pickFirstWorking(candidates.user);
  const text = await pickFirstWorking(candidates.text);
  const reply = await pickFirstWorking(candidates.reply);

  return { item, user, text, reply };
}

// fabrique un échantillon lisible
async function sampleComments(page, sels, max = 5) {
  if (!sels.item) return [];
  const items = page.locator(sels.item);
  const total = await items.count().catch(() => 0);
  const take = Math.min(max, total);
  const out = [];
  for (let i = 0; i < take; i++) {
    const root = items.nth(i);
    const user = sels.user ? await root.locator(sels.user).first().innerText().catch(() => null) : null;
    const text = sels.text ? await root.locator(sels.text).first().innerText().catch(() => null) : null;
    out.push({ index: i, user, text });
  }
  return out;
}

// lance un contexte avec session (cookies Supabase)
async function getContextWithSession({ account = TTK_ACCOUNT, platform = TTK_PLATFORM }) {
  if (!hasSupabase) throw new Error('Supabase not configured');
  const session = await loadSession(platform, account);
  if (!session) throw new Error('No session in DB for this account/platform');

  const cookiesRaw = Array.isArray(session.cookies) ? session.cookies : [];
  const cookiesPW = toPlaywrightCookiesStrict(cookiesRaw);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: session.user_agent || undefined,
    viewport: { width: 1280, height: 900 },
  });

  for (let i = 0; i < cookiesPW.length; i++) {
    const ck = cookiesPW[i];
    await context.addCookies([ck]).catch((e) => {
      throw new Error(`cookie[${i}] "${ck.name}": ${e.message}`);
    });
  }

  const page = await context.newPage();
  return { browser, context, page };
}
// ===========================================================

// ---------- RUN MODES ----------
app.post('/run', async (req, res) => {
  const mode = req.body.mode || 'smoke';
  if (mode === 'smoke')                 return smokeRun(req, res);
  if (mode === 'tiktok.check')          return tiktokCheck(req, res);
  if (mode === 'tiktok.debugSelectors') return tiktokDebugSelectors(req, res);
  if (mode === 'tiktok.fetchComments')  return tiktokFetchComments(req, res);
  if (mode === 'tiktok.reply')          return tiktokReply(req, res);
  return res.json({ ok: true, mode });
});

// --- smoke
async function smokeRun(_req, res) {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(SMOKE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const title = await page.title();
  const url = page.url();
  await browser.close();
  res.json({ ok: true, title, url });
}

// --- tiktok.check
async function tiktokCheck(req, res) {
  const account = req.body.account || TTK_ACCOUNT;
  const platform = (req.body.platform || TTK_PLATFORM || 'tiktok').toLowerCase();
  if (!hasSupabase) return res.json({ ok: false, error: 'Supabase not configured' });
  if (!account) return res.json({ ok: false, error: 'Missing "account"' });

  try {
    const session = await loadSession(platform, account);
    if (!session) return res.json({ ok: false, error: 'No session in DB for this account/platform' });

    const cookiesPW = toPlaywrightCookiesStrict(session.cookies || []);
    const browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({
      userAgent: session.user_agent || undefined,
      viewport: { width: 1280, height: 900 },
    });

    try {
      for (let i = 0; i < cookiesPW.length; i++) {
        await context.addCookies([cookiesPW[i]]);
      }
    } catch (e) {
      await browser.close();
      return res.json({ ok: false, error: `addCookies: ${e.message}` });
    }

    const page = await context.newPage();
    await page.goto(TTK_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    let loggedIn = false;
    try {
      const avatar = await page.locator('[data-e2e="nav-user-avatar"]').first().isVisible().catch(() => false);
      const loginBtn = await page.locator('[data-e2e="top-login-button"], a[href*="/login"]').first().isVisible().catch(() => false);
      const names = new Set((session.cookies || []).map((c) => c.name));
      const hasSess = names.has('sessionid') || names.has('sessionid_ss') || names.has('sid_tt');
      loggedIn = Boolean(avatar || (hasSess && !loginBtn));
    } catch (_) {}

    const title = await page.title().catch(() => null);
    const url = page.url();
    await browser.close();
    res.json({ ok: true, usedSupabase: true, account, platform, loggedIn, title, url, cookiesCount: cookiesPW.length });
  } catch (e) {
    res.json({ ok: false, error: e.message || String(e) });
  }
}

// --- DEBUG SELECTORS (renvoie ce qui “matche” vraiment)
async function tiktokDebugSelectors(req, res) {
  const { videoUrl, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!videoUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  try {
    const { browser, page } = await getContextWithSession({ account, platform });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await openCommentsPanel(page);

    const sels = await discoverSelectors(page);
    const sample = await sampleComments(page, sels, 5);

    // comptages
    const counts = {};
    for (const [k, v] of Object.entries(sels)) {
      counts[k] = v ? await page.locator(v).count().catch(() => 0) : 0;
    }

    await browser.close();
    return res.json({ ok: true, url: videoUrl, selectors: sels, counts, sample });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// --- FETCH COMMENTS
async function tiktokFetchComments(req, res) {
  const { videoUrl, limit = 5, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!videoUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  try {
    const { browser, page } = await getContextWithSession({ account, platform });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await openCommentsPanel(page);

    const sels = await discoverSelectors(page);

    if (!sels.item) {
      await browser.close();
      return res.json({ ok: true, count: 0, comments: [], url: videoUrl });
    }

    // scroll supplémentaire pour forcer la virtualisation à hydrater
    const panel = page.locator('div[class*="DivCommentContainer"], div[data-e2e="comment-list"]').first();
    for (let i = 0; i < 8; i++) {
      await panel.evaluate((el) => { el.scrollBy?.(0, 1400); }, {}).catch(() => {});
      await page.waitForTimeout(250);
    }

    const items = page.locator(sels.item);
    const total = await items.count().catch(() => 0);
    const take = Math.min(limit, total);

    const comments = [];
    for (let i = 0; i < take; i++) {
      const root = items.nth(i);
      const user = sels.user ? await root.locator(sels.user).first().innerText().catch(() => null) : null;
      const text = sels.text ? await root.locator(sels.text).first().innerText().catch(() => null) : null;
      if (user || text) comments.push({ index: i, user, text });
    }

    await browser.close();
    return res.json({ ok: true, count: comments.length, comments, url: videoUrl });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// --- REPLY
async function tiktokReply(req, res) {
  const {
    videoUrl, replyText,
    commentIndex = 0,
    account = TTK_ACCOUNT, platform = TTK_PLATFORM,
  } = req.body;

  if (!videoUrl || !replyText) return res.json({ ok: false, error: 'Missing "videoUrl" or "replyText"' });

  try {
    const { browser, page } = await getContextWithSession({ account, platform });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await openCommentsPanel(page);

    const sels = await discoverSelectors(page);
    if (!sels.item) {
      await browser.close();
      return res.json({ ok: false, error: `No comment items found`, url: videoUrl });
    }

    // s’assurer que l’item visé est rendu (scroll ciblé)
    const items = page.locator(sels.item);
    const total = await items.count().catch(() => 0);
    if (commentIndex < 0 || commentIndex >= total) {
      await browser.close();
      return res.json({ ok: false, error: `commentIndex ${commentIndex} not found`, url: videoUrl });
    }

    const target = items.nth(commentIndex);
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);

    // cliquer sur "Répondre"/"Reply" relatif à l’item (fallback: focus le champ global)
    let clicked = false;
    if (sels.reply) {
      const btn = target.locator(sels.reply).first();
      if (await btn.count()) {
        await closeOverlays(page);
        await btn.click({ timeout: 4000 }).then(() => { clicked = true; }).catch(() => {});
      }
    }

    // champ d’input de réponse (local ou global)
    const input = page.locator('[data-e2e="comment-input"], textarea').first();

    // si pas cliqué, on tente de focus l’input global directement
    if (!clicked) {
      await closeOverlays(page);
      await input.click({ timeout: 4000 }).catch(() => {});
    }

    await input.fill(replyText, { timeout: 4000 }).catch(async () => {
      // dernier recours: type direct
      await input.focus().catch(() => {});
      await page.keyboard.type(replyText, { delay: 20 }).catch(() => {});
    });

    await closeOverlays(page);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(2000);

    await browser.close();
    return res.json({ ok: true, videoUrl, commentIndex, replyText });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

