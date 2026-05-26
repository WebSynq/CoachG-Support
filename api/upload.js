// api/upload.js — GHL Media Library upload proxy
// Receives base64 image from browser, forwards as multipart to GHL, returns the media URL.
// Keeps GHLAPI_KEY server-side, never exposed to browser.
// Env vars required: GHLAPI_KEY, ALLOWED_ORIGINS (comma-separated) or ALLOWED_ORIGIN

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '8mb'
    }
  }
};

const rateLimitMap = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function setCORSHeaders(res, allowedOrigin) {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const MAX_BASE64_LENGTH = 7 * 1024 * 1024; // ~5MB raw → ~6.7MB base64

export default async function handler(req, res) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  const rawOrigin = req.headers.origin || req.headers.referer || '';
  const origin = rawOrigin.replace(/(https?:\/\/[^\/]+).*/, '$1');
  const matchedOrigin = allowedOrigins.find(allowed => origin.startsWith(allowed));
  const originAllowed = allowedOrigins.length === 0 || !!matchedOrigin;
  const corsOrigin = matchedOrigin || allowedOrigins[0] || '';

  if (req.method === 'OPTIONS') {
    setCORSHeaders(res, corsOrigin);
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Origin validation
  // ⚠️ SECURITY NOTE: Never remove this check.
  if (!originAllowed) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // 2. Rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // 3. Validate env
  if (!process.env.GHLAPI_KEY) {
    console.error('[upload] GHLAPI_KEY not configured');
    return res.status(500).json({ error: 'Upload service not configured' });
  }

  // 4. Validate payload
  const { name, type, base64, locationId } = req.body || {};
  if (!name || typeof name !== 'string' || name.length > 255) {
    return res.status(400).json({ error: 'Invalid file name' });
  }
  if (!type || typeof type !== 'string' || !type.startsWith('image/')) {
    return res.status(400).json({ error: 'Only image uploads allowed' });
  }
  if (!base64 || typeof base64 !== 'string' || base64.length > MAX_BASE64_LENGTH) {
    return res.status(400).json({ error: 'File missing or too large (max ~5MB)' });
  }

  // 5. Convert base64 → multipart and forward to GHL
  // ⚠️ SECURITY NOTE: GHLAPI_KEY lives only in env vars. Never log it.
  try {
    const buffer = Buffer.from(base64, 'base64');
    const blob = new Blob([buffer], { type });
    const formData = new FormData();
    formData.append('file', blob, name);
    if (locationId && typeof locationId === 'string' && locationId !== 'null' && locationId.trim()) {
      formData.append('locationId', locationId);
    }

    const ghlRes = await fetch('https://services.leadconnectorhq.com/medias/upload-file', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.GHLAPI_KEY,
        'Version': '2021-07-28'
      },
      body: formData
    });

    const ghlBody = await ghlRes.text();

    if (!ghlRes.ok) {
      console.error('[upload] GHL returned error:', ghlRes.status, ghlBody.slice(0, 300));
      return res.status(502).json({ error: 'Upload to GHL failed', status: ghlRes.status });
    }

    let data = {};
    try { data = JSON.parse(ghlBody); } catch (_) { /* leave as empty */ }

    console.log('[upload] Uploaded:', name, '→', data.fileId || data.url || '(no id returned)');
    setCORSHeaders(res, corsOrigin);
    return res.status(200).json({ url: data.url || null, fileId: data.fileId || null });

  } catch (err) {
    console.error('[upload] Proxy error:', err.message);
    return res.status(500).json({ error: 'Upload error' });
  }
}
