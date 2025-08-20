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

// Convertit un export Cookie-Editor → cookies Playwright (basés sur url)
const toPlaywrightCookiesStrict = (raw = []) =>
  raw
    .filter((c) => c && typeof c.name === 'string' && c.name.length > 0 && c.value !== undefined)
    .map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value ?? ''),
        url: TTK_BASE_URL, // pas de domain/path ⇒ évite l'erreur addCookies
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      };
      const ss = mapSameSite(c.sameSite);
      if (ss) out.sameSite = ss;
      if (ss === 'None') out.secure = true; // règle web: SameSite=None ⇒ Secure
      let exp = Number(c.expirationDate ?? c.expiry);
      if (Number.isFinite(exp) && exp > 0) {
        if (exp > 1e12) exp = Math.floor(exp / 1000); // au cas où ms
        out.expires = Math.floor(exp);
      }
      return out;
    });

// flags utiles pour debug
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

// ===================== SELECTORS & HELPERS (UI) =====================
const COMMENT_ITEM_SEL =
  '[data-e2e="comment-item"], div[data-e2e^="comment-item"], li[class*="CommentItem"]';
const REPLY_BUTTON_SEL =
  '[data-e2e="comment-reply"], button:has-text("Reply"), button:has-text("Répondre")';

// Ouvre le panneau de commentaires si besoin
async function openCommentsPanel(page) {
  if (await page.locator(COMMENT_ITEM_SEL).first().isVisible().catch(() => false)) return;

  const toggles = [
    '[data-e2e="browse-comment-icon"]',
    '[data-e2e="comment-icon"]',
    'button[aria-label*="omment"]',
    'button:has-text("Commentaires")',
    'button:has-text("Comments")',
  ];
  for (const sel of toggles) {
    const loc = page.locator(sel).first();
    if (await loc.count()) {
      await loc.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (await page.locator(COMMENT_ITEM_SEL).count()) return;
    }
  }
  await page.keyboard.press('c').catch(() => {});
  await page.waitForTimeout(600);
}

// Force le rendu/virtualisation des items
async function nudgeForComments(page) {
  for (let i = 0; i < 6; i++) {
    if (await page.locator(COMMENT_ITEM_SEL).count()) break;
    await page.mouse.wheel(0, 1200).catch(() => {});
    await page.waitForTimeout(600);
  }
}

// Construit un contexte Playwright avec la session (cookies+UA)
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
// ====================================================================

// ---------- RUN MODES ----------
app.post('/run', async (req, res) => {
  const mode = req.body.mode || 'smoke';

  if (mode === 'smoke') return smokeRun(req, res);
  if (mode === 'tiktok.check') return tiktokCheck(req, res);
  if (mode === 'tiktok.fetchComments') return tiktokFetchComments(req, res);
  if (mode === 'tiktok.reply') return tiktokReply(req, res);
  if (mode === 'tiktok.debugSelectors') return tiktokDebugSelectors(req, res);

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

// Récupère les N premiers commentaires d’une vidéo
async function tiktokFetchComments(req, res) {
  const { videoUrl, limit = 5, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!videoUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  let browser;
  try {
    const ctx = await getContextWithSession({ account, platform });
    browser = ctx.browser;
    const page = ctx.page;

    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle').catch(() => {});

    await openCommentsPanel(page);
    await nudgeForComments(page);

    const comments = await page.evaluate(({ max, itemSel }) => {
      const items = Array.from(document.querySelectorAll(itemSel));
      return items.slice(0, max).map((el, idx) => {
        const user =
          el.querySelector('[data-e2e="comment-username"]')?.textContent?.trim() ||
          el.querySelector('a[href*="/@"]')?.textContent?.trim() ||
          null;
        const text =
          el.querySelector('[data-e2e="comment-content"]')?.textContent?.trim() ||
          el.querySelector('[data-e2e*="comment"]')?.textContent?.trim() ||
          null;
        const time = el.querySelector('time')?.getAttribute('datetime') || null;
        return { index: idx, user, text, time };
      });
    }, { max: limit, itemSel: COMMENT_ITEM_SEL });

    await browser.close();
    return res.json({ ok: true, count: comments.length, comments, url: videoUrl });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
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

  let browser;
  try {
    const ctx = await getContextWithSession({ account, platform });
    browser = ctx.browser;
    const page = ctx.page;

    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle').catch(() => {});

    await openCommentsPanel(page);
    await nudgeForComments(page);

    const list = page.locator(COMMENT_ITEM_SEL);
    const total = await list.count();
    if (total === 0) {
      await browser.close();
      return res.json({ ok: false, error: 'No comments visible (maybe disabled or not loaded).' });
    }
    if (commentIndex < 0 || commentIndex >= total) {
      await browser.close();
      return res.json({ ok: false, error: `commentIndex out of range (0..${total - 1})` });
    }

    const item = list.nth(commentIndex);
    await item.scrollIntoViewIfNeeded().catch(() => {});
    await item.hover().catch(() => {});
    await page.waitForTimeout(250);

    const replyBtn = item.locator(REPLY_BUTTON_SEL).first();
    await replyBtn.waitFor({ state: 'visible', timeout: 10000 });
    await replyBtn.click();

    // champs possibles: input, textarea, contenteditable
    const input = page
      .locator('[data-e2e="comment-input"], textarea, div[contenteditable="true"][role="textbox"], div[contenteditable="true"]')
      .first();
    await input.waitFor({ state: 'visible', timeout: 10000 });

    const didFill = await input.fill(replyText).then(() => true).catch(() => false);
    if (!didFill) {
      await input.click().catch(() => {});
      await page.keyboard.type(replyText, { delay: 20 });
    }

    // Envoi: Enter puis fallback bouton
    await page.keyboard.press('Enter').catch(() => {});
    await page
      .locator('button:has-text("Envoyer"), button:has-text("Send"), [data-e2e="comment-post"], [data-e2e="post-comment"]')
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});

    await page.waitForTimeout(2000);

    await browser.close();
    return res.json({ ok: true, videoUrl, commentIndex, replyText });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// Diagnostic des sélecteurs/état UI commentaires
async function tiktokDebugSelectors(req, res) {
  const { videoUrl, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!videoUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  let browser;
  try {
    const ctx = await getContextWithSession({ account, platform });
    browser = ctx.browser;
    const page = ctx.page;

    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await openCommentsPanel(page);
    await nudgeForComments(page);

    const toggles = [
      '[data-e2e="browse-comment-icon"]',
      '[data-e2e="comment-icon"]',
      'button[aria-label*="omment"]',
      'button:has-text("Commentaires")',
      'button:has-text("Comments")',
    ];

    const snap = await page.evaluate(({ itemSel, replySel, toggles }) => {
      const q = (sel) => Array.from(document.querySelectorAll(sel));
      const vis = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

      const items = q(itemSel);
      const first = items[0] || null;
      const firstReply = first ? (first.querySelector('[data-e2e="comment-reply"]') ||
                                  Array.from(first.querySelectorAll('button')).find(b => /Reply|Répondre/i.test(b.textContent || '')) || null) : null;

      const toggleState = toggles.map((sel) => {
        const el = document.querySelector(sel);
        return { sel, present: !!el, visible: el ? vis(el) : false };
      });

      return {
        counts: {
          commentItems: items.length,
          firstItemButtons: first ? (first.querySelectorAll('button') || []).length : 0,
        },
        firstItem: {
          exists: !!first,
          hasReplyBtn: !!firstReply,
          replyBtnText: firstReply ? (firstReply.textContent || '').trim() : null,
        },
        toggles: toggleState,
      };
    }, { itemSel: COMMENT_ITEM_SEL, replySel: REPLY_BUTTON_SEL, toggles });

    const title = await page.title().catch(() => null);
    const url = page.url();

    await browser.close();
    return res.json({ ok: true, title, url, selectors: { COMMENT_ITEM_SEL, REPLY_BUTTON_SEL }, snapshot: snap });
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return res.json({ ok: false, error: e.message || String(e) });
  }
}
// ============================================================

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

