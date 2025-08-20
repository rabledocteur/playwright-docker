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

// Cookie-Editor -> Playwright (format basé sur url)
const toPlaywrightCookiesStrict = (raw = []) =>
  raw
    .filter((c) => c && typeof c.name === 'string' && c.name.length > 0 && c.value !== undefined)
    .map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value ?? ''),
        url: TTK_BASE_URL, // évite les erreurs path/url
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      };
      const ss = mapSameSite(c.sameSite);
      if (ss) out.sameSite = ss;
      if (ss === 'None') out.secure = true; // règle web
      let exp = Number(c.expirationDate ?? c.expiry);
      if (Number.isFinite(exp) && exp > 0) {
        if (exp > 1e12) exp = Math.floor(exp / 1000);
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
  if (!data || !data.length) return null;
  return data[0];
}

// ---------- AUTH: ENREGISTRE LES COOKIES EN DB ----------
app.post('/auth/set-cookies', async (req, res) => {
  try {
    const platform = (req.body.platform || TTK_PLATFORM || 'tiktok').toLowerCase();
    const account = req.body.account || TTK_ACCOUNT;
    const cookies = req.body.cookies;

    if (!Array.isArray(cookies)) {
      return res.status(400).json({ ok: false, error: 'Body must include "cookies": []' });
    }
    if (!account) {
      return res.status(400).json({ ok: false, error: 'Missing "account"' });
    }

    const saved = await upsertSession({
      platform,
      account,
      cookies,
      user_agent: req.body.user_agent || req.headers['user-agent'] || null,
    });

    return res.json({
      ok: true,
      platform,
      account,
      saved: cookies.length,
      flags: cookieFlags(cookies),
      rowId: saved?.id || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ===================== HELPERS =====================
async function getContextWithSession({ account = TTK_ACCOUNT, platform = TTK_PLATFORM }) {
  if (!hasSupabase) throw new Error('Supabase not configured');
  const session = await loadSession(platform, account);
  if (!session) throw new Error('No session in DB for this account/platform');

  const cookiesPW = toPlaywrightCookiesStrict(Array.isArray(session.cookies) ? session.cookies : []);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: session.user_agent || undefined,
    viewport: { width: 1400, height: 900 },
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

async function ensureCommentsPane(page) {
  // 1) si un onglet "Commentaires/Comments" existe, on clique
  const tab = page.getByRole('tab', {
    name: /Commentaires|Comments|Comentarios|Kommentare|Bình luận|Yorumlar|Коммент/i,
  });
  if (await tab.count()) {
    await tab.first().click({ trial: false }).catch(() => {});
  }

  // 2) attendre qu'au moins un item apparaisse (ou replier si besoin)
  const list = page.locator('[data-e2e="comment-item"], li.CommentItem');
  await list.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  // 3) petit scroll pour forcer le lazy-load
  await page.mouse.wheel(0, 1200).catch(() => {});
  await page.waitForTimeout(600);
  return list;
}

async function safeInnerText(locator) {
  try {
    if (!(await locator.count())) return null;
    const txt = await locator.first().innerText({ timeout: 1000 }).catch(() => null);
    return (txt || '').trim() || null;
  } catch {
    return null;
  }
}

function normalizeVideoUrl(u) {
  if (!u) return u;
  try {
    const url = new URL(u);
    url.search = ''; // vire ?lang=fr etc.
    return url.toString();
  } catch {
    return u;
  }
}
// ===================================================

// ---------- RUN MODES ----------
app.post('/run', async (req, res) => {
  const mode = req.body.mode || 'smoke';

  if (mode === 'smoke')                return smokeRun(req, res);
  if (mode === 'tiktok.check')         return tiktokCheck(req, res);
  if (mode === 'tiktok.fetchComments') return tiktokFetchComments(req, res);
  if (mode === 'tiktok.reply')         return tiktokReply(req, res);
  if (mode === 'tiktok.debugSelectors')return tiktokDebugSelectors(req, res);

  return res.json({ ok: true, mode }); // fallback debug
});

// --- mode: smoke
async function smokeRun(_req, res) {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await page.goto(SMOKE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const title = await page.title();
  const url = page.url();

  await browser.close();
  return res.json({ ok: true, title, url });
}

// --- mode: tiktok.check
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
      viewport: { width: 1280, height: 800 },
    });

    try {
      for (let i = 0; i < cookiesPW.length; i++) {
        const ck = cookiesPW[i];
        await context.addCookies([ck]).catch((e) => {
          throw new Error(`cookie[${i}] "${ck.name}": ${e.message}`);
        });
      }
    } catch (e) {
      await browser.close();
      return res.json({ ok: false, error: `addCookies: ${e.message}` });
    }

    const page = await context.newPage();
    await page.goto(TTK_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Détection simple
    let loggedIn = false;
    try {
      const avatar = await page.locator('[data-e2e="nav-user-avatar"]').first().isVisible().catch(() => false);
      const loginBtn = await page.locator('[data-e2e="top-login-button"], a[href*="/login"]').first().isVisible().catch(() => false);
      const names = new Set((session.cookies || []).map((c) => c.name));
      const hasSess = names.has('sessionid') || names.has('sessionid_ss') || names.has('sid_tt');
      loggedIn = Boolean(avatar || (hasSess && !loginBtn));
    } catch {}

    const title = await page.title().catch(() => null);
    const url = page.url();

    await browser.close();
    return res.json({ ok: true, usedSupabase: true, account, platform, loggedIn, title, url, cookiesCount: cookiesPW.length });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// --- mode: tiktok.fetchComments
async function tiktokFetchComments(req, res) {
  const { videoUrl: rawUrl, limit = 5, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!rawUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  const videoUrl = normalizeVideoUrl(rawUrl);

  try {
    const { browser, page } = await getContextWithSession({ account, platform });

    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const list = await ensureCommentsPane(page);

    // Attendre un peu que la liste se peuple
    await page.waitForTimeout(800);

    const items = page.locator('[data-e2e="comment-item"], li.CommentItem');
    const total = await items.count();
    const take = Math.min(Number(limit) || 5, Math.max(total, 0));

    const comments = [];
    for (let i = 0; i < take; i++) {
      const el = items.nth(i);
      const user = await safeInnerText(
        el.locator('[data-e2e="comment-username"], a[href*="/@"]').first()
      );
      const text = await safeInnerText(
        el.locator('[data-e2e="comment-content"], [data-e2e*="comment"]').first()
      );
      const time = await el.locator('time').first().getAttribute('datetime').catch(() => null);
      comments.push({ index: i, user, text, time });
    }

    await browser.close();
    return res.json({ ok: true, count: comments.length, comments, url: videoUrl });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e), url: videoUrl });
  }
}

// --- mode: tiktok.reply
async function tiktokReply(req, res) {
  const {
    videoUrl: rawUrl,
    replyText,
    commentIndex = 0,
    account = TTK_ACCOUNT,
    platform = TTK_PLATFORM,
  } = req.body;

  if (!rawUrl || !replyText) {
    return res.json({ ok: false, error: 'Missing "videoUrl" or "replyText"' });
  }
  const videoUrl = normalizeVideoUrl(rawUrl);

  try {
    const { browser, page } = await getContextWithSession({ account, platform });

    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const list = await ensureCommentsPane(page);

    // cibler le commentaire voulu
    const items = page.locator('[data-e2e="comment-item"], li.CommentItem');
    const exists = (await items.count()) > Number(commentIndex);
    if (!exists) {
      await browser.close();
      return res.json({ ok: false, error: `commentIndex ${commentIndex} not found`, url: videoUrl });
    }

    const item = items.nth(Number(commentIndex));

    // bouton Répondre / Reply (robuste multi-langue)
    const replyBtn = item
      .getByRole('button', { name: /répondre|reply|responder|antworten|yanıtla|ответить/i })
      .first();

    await replyBtn.click({ timeout: 12000 });

    // zone de saisie
    const input = page.locator('[data-e2e="comment-input"], textarea, [contenteditable="true"]').first();
    await input.waitFor({ state: 'visible', timeout: 8000 });
    // quelques UX guardrails
    try { await input.click({ clickCount: 1 }); } catch {}

    // entrer le texte + valider
    try {
      await input.fill(replyText, { timeout: 5000 });
    } catch {
      // fallback contenteditable
      await page.keyboard.type(replyText, { delay: 20 });
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    await browser.close();
    return res.json({ ok: true, videoUrl, commentIndex: Number(commentIndex), replyText });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e), url: videoUrl });
  }
}

// --- mode: tiktok.debugSelectors
async function tiktokDebugSelectors(req, res) {
  const { videoUrl: rawUrl, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!rawUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  const videoUrl = normalizeVideoUrl(rawUrl);

  try {
    const { browser, page } = await getContextWithSession({ account, platform });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const list = await ensureCommentsPane(page);
    await page.waitForTimeout(600);

    const counts = {
      commentItem: await page.locator('[data-e2e="comment-item"]').count(),
      commentItemAlt: await page.locator('li.CommentItem').count(),
      commentUser: await page.locator('[data-e2e="comment-username"], a[href*="/@"]').count(),
      commentText: await page.locator('[data-e2e="comment-content"], [data-e2e*="comment"]').count(),
      replyButtons: await page.getByRole('button', { name: /répondre|reply|responder|antworten|yanıtla|ответить/i }).count(),
    };

    const firstHtml = await page
      .locator('[data-e2e="comment-item"], li.CommentItem')
      .first()
      .evaluate((el) => el?.outerHTML)
      .catch(() => null);

    await browser.close();
    return res.json({ ok: true, url: videoUrl, counts, firstCommentHtml: firstHtml });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e), url: videoUrl });
  }
}

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

