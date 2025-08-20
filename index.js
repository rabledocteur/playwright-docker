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

// Convertit export Cookie-Editor → cookies Playwright (basés sur url)
const toPlaywrightCookiesStrict = (raw = []) => {
  return raw
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
      if (ss === 'None') out.secure = true;

      let exp = Number(c.expirationDate ?? c.expiry);
      if (Number.isFinite(exp) && exp > 0) {
        if (exp > 1e12) exp = Math.floor(exp / 1000); // corrige ms → s si besoin
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

// ===================== HELPERS UI =====================

// Ouvre le navigateur/ctx/page avec session depuis Supabase
async function getContextWithSession({ account = TTK_ACCOUNT, platform = TTK_PLATFORM }) {
  if (!hasSupabase) throw new Error('Supabase not configured');
  const session = await loadSession(platform, account);
  if (!session) throw new Error('No session in DB for this account/platform');

  const cookiesRaw = Array.isArray(session.cookies) ? session.cookies : [];
  const cookiesPW = toPlaywrightCookiesStrict(cookiesRaw);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: session.user_agent || undefined,
    viewport: { width: 1366, height: 900 },
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

// Clique l’onglet “Commentaires / Comments” si présent
async function clickCommentsTab(page) {
  const tab = page.locator(
    'button:has-text("Commentaires"), button:has-text("Comments"), [data-e2e="comment-tab"]'
  );
  if (await tab.count()) {
    await tab.first().click({ timeout: 3000 }).catch(() => {});
  }
}

// Essaie de trouver le panneau scrollable des commentaires
async function getCommentsPanel(page) {
  const candidates = [
    '[data-e2e="comment-list"]',
    '[data-e2e="comment-container"]',
    '[class*="CommentList"]',
    '[class*="comment"] ul',
    '[class*="comment"] [role="list"]',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel);
    if ((await loc.count()) && (await loc.first().isVisible().catch(() => false))) {
      return loc.first();
    }
  }
  // fallback: la colonne droite (paneau vidéo)
  const right = page.locator('[data-e2e="browse-right"], [class*="Right"], [class*="Side"]');
  if (await right.count()) return right.first();
  return null;
}

// Scroll (paneau commentaires si dispo, sinon page)
async function smartScrollComments(page, times = 3) {
  const panel = await getCommentsPanel(page);
  for (let i = 0; i < times; i++) {
    if (panel) {
      await panel.evaluate((el) => el.scrollBy(0, el.clientHeight * 0.9)).catch(() => {});
    } else {
      await page.mouse.wheel(0, 1200).catch(() => {});
    }
    await page.waitForTimeout(700);
  }
}

// Attend l’apparition de quelques nodes utiles dans le panneau
async function waitCommentsReady(page) {
  await clickCommentsTab(page);
  // Une des 3 conditions suffit
  const username = page.locator('[data-e2e="comment-username"], a[href^="/@"]');
  const content = page.locator('[data-e2e="comment-content"]');
  const input = page.locator('[data-e2e="comment-input"], textarea[placeholder*="comment"]');
  await Promise.race([
    username.first().waitFor({ state: 'visible', timeout: 7000 }).catch(() => {}),
    content.first().waitFor({ state: 'visible', timeout: 7000 }).catch(() => {}),
    input.first().waitFor({ state: 'visible', timeout: 7000 }).catch(() => {}),
  ]);
  // petit scroll pour déclencher la virtualisation
  await smartScrollComments(page, 2);
}

// Extrait des couples (user, text) par index robuste
async function extractComments(page, limit = 5) {
  const userLoc = page.locator('[data-e2e="comment-username"], a[href^="/@"]');
  const textLoc = page.locator('[data-e2e="comment-content"]');

  const userN = await userLoc.count();
  const textN = await textLoc.count();
  const n = Math.min(limit, Math.max(0, Math.min(userN, textN)));

  const items = [];
  for (let i = 0; i < n; i++) {
    const user = (await userLoc.nth(i).innerText().catch(() => '')).trim();
    const text = (await textLoc.nth(i).innerText().catch(() => '')).trim();
    if (user || text) items.push({ index: i, user: user || null, text: text || null });
  }
  return items;
}

// Click "Reply/Répondre" près du commentaire index (si visible), sinon fallback mention
async function replyToComment(page, commentIndex, replyText) {
  // Essaye via un groupement DOM proche du username
  const userLoc = page.locator('[data-e2e="comment-username"], a[href^="/@"]');
  const count = await userLoc.count();
  if (!count || commentIndex >= count) {
    throw new Error(`commentIndex ${commentIndex} not found`);
  }

  const targetUser = (await userLoc.nth(commentIndex).innerText().catch(() => '')).trim();

  // scroll jusque-là
  await userLoc.nth(commentIndex).scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);

  // 1) tentative: bouton Répondre à proximité
  const replyNear = userLoc
    .nth(commentIndex)
    .locator(
      'xpath=ancestor::*[self::li or self::div][.//node()][1]//button[contains(.,"Reply") or contains(.,"Répondre") or @data-e2e="comment-reply"]'
    )
    .first();

  const canClick = await replyNear.isVisible().catch(() => false);
  if (canClick) {
    await replyNear.click({ timeout: 3000 }).catch(() => {});
  }

  // 2) saisie dans l’input (reply ou nouveau commentaire si pas de bouton)
  const input = page.locator('[data-e2e="comment-input"], textarea');
  await input.first().click({ timeout: 4000 });
  const textToSend = targetUser ? `@${targetUser} ${replyText}` : replyText;
  await input.first().fill(textToSend);
  // bouton publier / icône avion / Enter
  const sendBtn = page.locator(
    'button:has-text("Publier"), button:has-text("Post"), [data-e2e="comment-post"]'
  );
  if ((await sendBtn.count()) && (await sendBtn.first().isEnabled())) {
    await sendBtn.first().click().catch(() => {});
  } else {
    await page.keyboard.press('Enter').catch(() => {});
  }
  await page.waitForTimeout(1500);
}

// ===================== RUN MODES =====================
app.post('/run', async (req, res) => {
  const mode = req.body.mode || 'smoke';

  if (mode === 'smoke') return smokeRun(req, res);
  if (mode === 'tiktok.check') return tiktokCheck(req, res);
  if (mode === 'tiktok.fetchComments') return tiktokFetchComments(req, res);
  if (mode === 'tiktok.reply') return tiktokReply(req, res);
  if (mode === 'tiktok.debugSelectors') return tiktokDebugSelectors(req, res);

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

// --- mode: tiktok.fetchComments
async function tiktokFetchComments(req, res) {
  const { videoUrl, limit = 5, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!videoUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  try {
    const { browser, page } = await getContextWithSession({ account, platform });

    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitCommentsReady(page);
    await smartScrollComments(page, 2);

    const comments = await extractComments(page, limit);

    await browser.close();
    return res.json({ ok: true, count: comments.length, comments, url: videoUrl });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e), url: videoUrl });
  }
}

// --- mode: tiktok.reply
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
    await waitCommentsReady(page);
    await smartScrollComments(page, 3);

    // vérifie que l’index existe (sinon on récupère juste pour compter)
    const usersCount = await page.locator('[data-e2e="comment-username"], a[href^="/@"]').count();
    if (!usersCount || commentIndex >= usersCount) {
      await browser.close();
      return res.json({ ok: false, error: `commentIndex ${commentIndex} not found`, url: videoUrl });
    }

    await replyToComment(page, commentIndex, replyText);
    await browser.close();
    return res.json({ ok: true, videoUrl, commentIndex, replyText });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e), url: videoUrl });
  }
}

// --- mode: tiktok.debugSelectors
async function tiktokDebugSelectors(req, res) {
  const { videoUrl, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!videoUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  try {
    const { browser, page } = await getContextWithSession({ account, platform });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitCommentsReady(page);
    await smartScrollComments(page, 1);

    const counts = {
      commentUser: await page.locator('[data-e2e="comment-username"], a[href^="/@"]').count(),
      commentText: await page.locator('[data-e2e="comment-content"]').count(),
    };

    const sample = await extractComments(page, Math.min(5, counts.commentUser, counts.commentText));

    await browser.close();
    return res.json({ ok: true, url: videoUrl, counts, sample });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e), url: videoUrl });
  }
}

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

