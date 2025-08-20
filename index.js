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
const TTK_BASE_URL = 'https://www.tiktok.com/'; // slash final important

const mapSameSite = (v) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).toLowerCase();
  if (s === 'lax') return 'Lax';
  if (s === 'strict') return 'Strict';
  if (s === 'no_restriction' || s === 'none') return 'None';
  return undefined;
};

const toPlaywrightCookiesStrict = (raw = []) => {
  return raw
    .filter((c) => c && typeof c.name === 'string' && c.name.length > 0 && c.value !== undefined)
    .map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value ?? ''),
        url: TTK_BASE_URL,        // éviter l'erreur "Cookie should have either url or path"
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
};

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

// ---------- SUPABASE HELPERS ----------
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

// ===================== HELPERS PAGE/CONTEXT =====================
async function getContextWithSession({ account = TTK_ACCOUNT, platform = TTK_PLATFORM }) {
  if (!hasSupabase) throw new Error('Supabase not configured');
  const session = await loadSession(platform, account);
  if (!session) throw new Error('No session in DB for this account/platform');

  const cookiesRaw = Array.isArray(session.cookies) ? session.cookies : [];
  const cookiesPW = toPlaywrightCookiesStrict(cookiesRaw);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: session.user_agent || undefined,
    viewport: { width: 1280, height: 800 },
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

async function dismissOverlays(page) {
  // ferme modales TUX / overlays si présents
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.mouse.click(10, 10).catch(() => {});
    await page.waitForTimeout(150);
  }
}

// Sélecteurs (robustes / multilingues)
const SEL = {
  COMMENT_ITEM: '[data-e2e="comment-item"], li[class*="CommentItem"]',
  COMMENT_USER: '[data-e2e="comment-username"], [data-e2e="comment-user-name"], a[href^="/@"]',
  COMMENT_TEXT: 'span[data-e2e="comment-level-1"], [data-e2e="comment-text"]',
  REPLY_BTN_IN: 'button:has-text("Répondre"), button:has-text("Reply")',
  COMMENT_INPUT: '[data-e2e="comment-input"], textarea',
};

async function ensureCommentsReady(page) {
  await page.locator(SEL.COMMENT_USER).first().waitFor({ timeout: 15000 });
  // petit scroll pour stabiliser la zone des commentaires
  await page.mouse.wheel(0, 1200).catch(() => {});
  await page.waitForTimeout(500);
}
// ===============================================================

// ---------- RUN MODES ----------
app.post('/run', async (req, res) => {
  const mode = req.body.mode || 'smoke';

  if (mode === 'smoke')                return smokeRun(req, res);
  if (mode === 'tiktok.check')         return tiktokCheck(req, res);
  if (mode === 'tiktok.debugSelectors')return tiktokDebugSelectors(req, res);
  if (mode === 'tiktok.fetchComments') return tiktokFetchComments(req, res);
  if (mode === 'tiktok.reply')         return tiktokReply(req, res);

  return res.json({ ok: true, mode }); // fallback debug
});

// --- mode: smoke (test basique navigateur)
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

// --- mode: tiktok.check (utilise les cookies depuis Supabase)
async function tiktokCheck(req, res) {
  const account = req.body.account || TTK_ACCOUNT;
  const platform = (req.body.platform || TTK_PLATFORM || 'tiktok').toLowerCase();

  if (!hasSupabase) return res.json({ ok: false, error: 'Supabase not configured' });
  if (!account) return res.json({ ok: false, error: 'Missing "account"' });

  try {
    const session = await loadSession(platform, account);
    if (!session) return res.json({ ok: false, error: 'No session in DB for this account/platform' });

    const cookiesRaw = Array.isArray(session.cookies) ? session.cookies : [];
    const cookiesPW = toPlaywrightCookiesStrict(cookiesRaw);

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

    // Détection simple de connexion
    let loggedIn = false;
    try {
      const avatar = await page.locator('[data-e2e="nav-user-avatar"]').first().isVisible().catch(() => false);
      const loginBtn = await page
        .locator('[data-e2e="top-login-button"], a[href*="/login"]')
        .first()
        .isVisible()
        .catch(() => false);

      const names = new Set(cookiesRaw.map((c) => c.name));
      const hasSess = names.has('sessionid') || names.has('sessionid_ss') || names.has('sid_tt');

      loggedIn = Boolean(avatar || (hasSess && !loginBtn));
    } catch (_) {}

    const title = await page.title().catch(() => null);
    const url = page.url();

    await browser.close();
    return res.json({
      ok: true,
      usedSupabase: true,
      account,
      platform,
      loggedIn,
      title,
      url,
      cookiesCount: cookiesPW.length,
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// ===================== HANDLERS =====================

// Debug sélecteurs commentaires
async function tiktokDebugSelectors(req, res) {
  const { videoUrl, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!videoUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  try {
    const { browser, page } = await getContextWithSession({ account, platform });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissOverlays(page);
    await ensureCommentsReady(page);

    const counts = await page.evaluate((SEL) => {
      const count = (s) => document.querySelectorAll(s).length;
      return {
        commentItem: count(SEL.COMMENT_ITEM),
        commentUser: count(SEL.COMMENT_USER),
        commentText: count(SEL.COMMENT_TEXT),
        replyButtons: document.querySelectorAll(SEL.REPLY_BTN_IN).length,
      };
    }, SEL);

    const sample = await page.evaluate((SEL) => {
      const items = Array.from(document.querySelectorAll(SEL.COMMENT_ITEM)).slice(0, 5);
      return items.map((el, i) => {
        const u = el.querySelector(SEL.COMMENT_USER)?.textContent?.trim() || null;
        const t =
          el.querySelector(SEL.COMMENT_TEXT)?.textContent?.trim() ||
          el.querySelector('[data-e2e*="comment"]')?.textContent?.trim() ||
          null;
        return { index: i, user: u, text: t };
      });
    }, SEL);

    await browser.close();
    return res.json({ ok: true, url: videoUrl, counts, sample });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// Récupère N commentaires
async function tiktokFetchComments(req, res) {
  const { videoUrl, limit = 5, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!videoUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  try {
    const { browser, page } = await getContextWithSession({ account, platform });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissOverlays(page);
    await ensureCommentsReady(page);

    const comments = await page.evaluate(({ SEL, limit }) => {
      const items = Array.from(document.querySelectorAll(SEL.COMMENT_ITEM));
      return items.slice(0, Number(limit)).map((el, idx) => {
        const user =
          el.querySelector(SEL.COMMENT_USER)?.textContent?.trim() ||
          el.querySelector('a[href^="/@"]')?.textContent?.trim() ||
          null;
        const text =
          el.querySelector(SEL.COMMENT_TEXT)?.textContent?.trim() ||
          el.querySelector('[data-e2e*="comment"]')?.textContent?.trim() ||
          null;
        return { index: idx, user, text };
      });
    }, { SEL, limit });

    await browser.close();
    return res.json({ ok: true, count: comments.length, comments, url: videoUrl });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// Répond au commentaire n° commentIndex
async function tiktokReply(req, res) {
  const {
    videoUrl,
    replyText,
    commentIndex = 0,
    account = TTK_ACCOUNT,
    platform = TTK_PLATFORM,
  } = req.body;

  if (!videoUrl || !replyText) {
    return res.json({ ok: false, error: 'Missing "videoUrl" or "replyText"' });
  }

  try {
    const { browser, page } = await getContextWithSession({ account, platform });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissOverlays(page);
    await ensureCommentsReady(page);

    const item = page.locator(SEL.COMMENT_ITEM).nth(Number(commentIndex));
    await item.scrollIntoViewIfNeeded();
    const handle = (await item.locator(SEL.COMMENT_USER).first().textContent().catch(() => null))?.trim() || null;

    // 1) On tente le vrai bouton "Répondre"/"Reply"
    const replyBtn = item.getByRole('button', { name: /r[ée]pondre|reply/i });
    const hasBtn = await replyBtn.first().isVisible().catch(() => false);

    if (hasBtn) {
      await replyBtn.first().click({ timeout: 10000 });
      await dismissOverlays(page);
    }

    // 2) Cibler la zone de saisie et envoyer
    const input = page.locator(SEL.COMMENT_INPUT).first();
    await input.click({ timeout: 8000 }); // Overlay ? on retente après dismissal
    await dismissOverlays(page);
    await input.click({ timeout: 8000 });
    const mention = handle ? `@${handle.replace(/^@/, '')} ` : '';
    await input.fill(`${mention}${replyText}`);
    await page.keyboard.press('Enter');

    await page.waitForTimeout(2000);
    await browser.close();
    return res.json({ ok: true, videoUrl, commentIndex: Number(commentIndex), replyText, mentioned: handle || null });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}
// ============================================================

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

