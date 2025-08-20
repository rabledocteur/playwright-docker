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
const toPlaywrightCookiesStrict = (raw = []) => {
  return raw
    .filter((c) => c && typeof c.name === 'string' && c.name.length > 0 && c.value !== undefined)
    .map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value ?? ''),
        url: TTK_BASE_URL,              // pas de domain/path ⇒ évite l'erreur addCookies
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      };

      const ss = mapSameSite(c.sameSite);
      if (ss) out.sameSite = ss;
      if (ss === 'None') out.secure = true; // règle web

      let exp = Number(c.expirationDate ?? c.expiry);
      if (Number.isFinite(exp) && exp > 0) {
        if (exp > 1e12) exp = Math.floor(exp / 1000); // corrige ms
        out.expires = Math.floor(exp);
      }
      return out;
    });
};

// flags debug
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

// ===================== HELPERS BROWSER =====================
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

// Ouvre l’onglet Commentaires si présent
async function ensureCommentsOpen(page) {
  const commentsTab = page.getByRole('tab', { name: /commentaires|comments/i });
  if (await commentsTab.isVisible().catch(() => false)) {
    await commentsTab.click();
    await page.waitForTimeout(700);
  }
}

// Ferme un overlay/modal éventuel qui bloque les clics
async function closeBlockingOverlays(page) {
  // TUX modal overlay (TikTok)
  const overlay = page.locator('[data-station-status="open"][data-tux-color-scheme]');
  if (await overlay.first().isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    await overlay.first().waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
  }
}

// Scroll fort pour hydrater la liste de commentaires
async function hydrateComments(page, loops = 10) {
  for (let i = 0; i < loops; i++) {
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(400);
  }
}

// Sélecteurs robustes (fallback-chain)
const SEL = {
  // Item : deux variantes vues sur TikTok web
  item: 'div[class*="DivCommentObject"], [data-e2e="comment-item"], li[class*="CommentItem"]',
  // User : lien profil ou data-e2e
  user: 'a[href^="/@"], [data-e2e="comment-username"]',
  // Texte : data-e2e, sinon niveaux, sinon texte brut du bloc contenu
  text: '[data-e2e="comment-text"], span[data-e2e^="comment-level"], div[class*="DivCommentSubContent"]',
  // Bouton répondre (FR/EN)
  replyBtn: 'button:has-text("Répondre"), button:has-text("Reply"), [data-e2e="comment-reply"]',
  // Champ saisie
  input: '[data-e2e="comment-input"], textarea',
};

// ===================== RUN MODES ===========================
app.post('/run', async (req, res) => {
  const mode = req.body.mode || 'smoke';

  if (mode === 'smoke')                return smokeRun(req, res);
  if (mode === 'tiktok.check')         return tiktokCheck(req, res);
  if (mode === 'tiktok.debugSelectors')return tiktokDebugSelectors(req, res);
  if (mode === 'tiktok.fetchComments') return tiktokFetchComments(req, res);
  if (mode === 'tiktok.reply')         return tiktokReply(req, res);

  return res.json({ ok: true, mode }); // fallback debug
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
  return res.json({ ok: true, title, url });
}

// --- check (ouvre tiktok.com avec cookies)
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
      viewport: { width: 1366, height: 900 },
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

    // Détection simple
    let loggedIn = false;
    try {
      const avatar = await page.locator('[data-e2e="nav-user-avatar"]').first().isVisible().catch(() => false);
      const loginBtn = await page.locator('[data-e2e="top-login-button"], a[href*="/login"]').first().isVisible().catch(() => false);
      const names = new Set(cookiesRaw.map((c) => c.name));
      const hasSess = names.has('sessionid') || names.has('sessionid_ss') || names.has('sid_tt');
      loggedIn = Boolean(avatar || (hasSess && !loginBtn));
    } catch (_) {}

    const title = await page.title().catch(() => null);
    const url = page.url();
    await browser.close();
    return res.json({
      ok: true, usedSupabase: true, account, platform, loggedIn, title, url, cookiesCount: cookiesPW.length,
    });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// --- debug selectors : compte ce que voit Playwright
async function tiktokDebugSelectors(req, res) {
  const { videoUrl, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!videoUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  try {
    const { browser, page } = await getContextWithSession({ account, platform });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await ensureCommentsOpen(page);
    await hydrateComments(page, 12);

    const counts = {
      item: await page.locator(SEL.item).count().catch(() => 0),
      user: await page.locator(SEL.user).count().catch(() => 0),
      text: await page.locator(SEL.text).count().catch(() => 0),
      reply: await page.locator(SEL.replyBtn).count().catch(() => 0),
    };

    const sample = [];
    const n = Math.min(counts.item, 3);
    for (let i = 0; i < n; i++) {
      const root = page.locator(SEL.item).nth(i);
      const u = await root.locator(SEL.user).first().textContent().catch(() => null);
      const t = await root.locator(SEL.text).first().textContent().catch(() => null);
      sample.push({ index: i, user: u?.trim() ?? null, text: t?.trim() ?? null });
    }

    await browser.close();
    return res.json({ ok: true, url: videoUrl, selectors: { ...SEL }, counts, sample });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// --- fetch comments
async function tiktokFetchComments(req, res) {
  const { videoUrl, limit = 5, account = TTK_ACCOUNT, platform = TTK_PLATFORM } = req.body;
  if (!videoUrl) return res.json({ ok: false, error: 'Missing "videoUrl"' });

  try {
    const { browser, page } = await getContextWithSession({ account, platform });
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await ensureCommentsOpen(page);
    await hydrateComments(page, 14);

    // Attends qu’au moins 1 item soit visible (si possible)
    const anyItem = page.locator(SEL.item).first();
    await anyItem.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

    const comments = await page.evaluate(({ SEL, limit }) => {
      const pick = (el, selList) => {
        for (const s of selList.split(',')) {
          const t = el.querySelector(s.trim());
          const val = t?.textContent?.trim();
          if (val) return val;
        }
        return null;
      };

      const nodes =
        Array.from(document.querySelectorAll(SEL.item)) ||
        [];

      return nodes.slice(0, limit).map((el, i) => {
        const user = pick(el, SEL.user);
        const text =
          pick(el, SEL.text) ||
          // dernier secours : coupe le texte de l’item
          (el.textContent || '').trim();
        return { index: i, user, text };
      }).filter(x => x.user || x.text);
    }, { SEL, limit });

    await browser.close();
    return res.json({ ok: true, count: comments.length, comments, url: videoUrl });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}

// --- reply
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
    await ensureCommentsOpen(page);
    await hydrateComments(page, 12);

    // Bouton "Répondre"
    const item = page.locator(SEL.item).nth(commentIndex);
    await item.scrollIntoViewIfNeeded().catch(() => {});
    const btn = item.locator(SEL.replyBtn).first();
    await btn.click({ timeout: 10000 });

    // Saisie
    await closeBlockingOverlays(page);
    const input = page.locator(SEL.input).first();
    await input.click({ timeout: 8000 });
    await input.fill(replyText);
    await page.keyboard.press('Enter');

    await page.waitForTimeout(1500);
    await browser.close();
    return res.json({ ok: true, videoUrl, commentIndex, replyText });
  } catch (e) {
    return res.json({ ok: false, error: e.message || String(e) });
  }
}
// ============================================================

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

