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
const TTK_BASE_URL = 'https://www.tiktok.com';

const mapSameSite = (v) => {
  if (!v && v !== 0) return undefined;
  const s = String(v).toLowerCase();
  if (s === 'lax') return 'Lax';
  if (s === 'strict') return 'Strict';
  if (s === 'no_restriction' || s === 'none') return 'None';
  return undefined; // on laisse Playwright décider
};

// Convertit un export Cookie-Editor → cookies Playwright sûrs (basés sur url)
const toPlaywrightCookiesStrict = (raw = []) => {
  return raw
    .filter((c) => c && typeof c.name === 'string' && c.name.length > 0 && c.value !== undefined)
    .map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value ?? ''),
        url: TTK_BASE_URL, // <-- clé: pas de domain/path → l’erreur disparaît
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      };
      const ss = mapSameSite(c.sameSite);
      if (ss) out.sameSite = ss;

      const exp = Number(c.expirationDate);
      if (Number.isFinite(exp) && exp > 0) out.expires = Math.floor(exp);

      return out;
    });
};

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

  const row = {
    platform,
    account,
    cookies,
    user_agent: user_agent || null,
  };

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
      user_agent: req.body.user_agent || null,
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

// ---------- RUN MODES ----------
app.post('/run', async (req, res) => {
  const mode = req.body.mode || 'smoke';

  if (mode === 'smoke') {
    return smokeRun(req, res);
  }

  if (mode === 'tiktok.check') {
    return tiktokCheck(req, res);
  }

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

// --- mode: tiktok.check (charge cookies depuis Supabase → injecte → visite TikTok)
async function tiktokCheck(req, res) {
  const account = req.body.account || TTK_ACCOUNT;
  const platform = (req.body.platform || TTK_PLATFORM || 'tiktok').toLowerCase();

  if (!hasSupabase) return res.json({ ok: false, error: 'Supabase not configured' });
  if (!account) return res.json({ ok: false, error: 'Missing "account"' });

  try {
    const session = await loadSession(platform, account);
    if (!session) {
      return res.json({ ok: false, error: 'No session in DB for this account/platform' });
    }

    const cookiesRaw = Array.isArray(session.cookies) ? session.cookies : [];
    const cookiesPW = toPlaywrightCookiesStrict(cookiesRaw);

    const browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({
      userAgent: session.user_agent || undefined,
      viewport: { width: 1280, height: 800 },
    });

    // Injection incrémentale → si un cookie est invalide, on sait lequel
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
      const avatar = await page
        .locator('[data-e2e="nav-user-avatar"]')
        .first()
        .isVisible()
        .catch(() => false);
      const loginBtn = await page
        .locator('[data-e2e="top-login-button"], a[href*="/login"]')
        .first()
        .isVisible()
        .catch(() => false);

      // secours via présence de cookies critiques
      const names = new Set(cookiesRaw.map((c) => c.name));
      const hasSess = names.has('sessionid') || names.has('sessionid_ss') || names.has('sid_tt');

      loggedIn = Boolean(avatar || (hasSess && !loginBtn));
    } catch (_) {
      // ignore
    }

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

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

