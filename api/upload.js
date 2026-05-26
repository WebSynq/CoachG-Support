// api/upload.js — Supabase Storage upload proxy
// Receives base64 image from browser, uploads to Supabase Storage, returns the public URL.
// Keeps SUPABASE_SERVICE_KEY server-side, never exposed to browser.
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_BUCKET, ALLOWED_ORIGINS (comma-separated) or ALLOWED_ORIGIN

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

function sanitizeFileName(name) {
  // Strip path separators, keep extension, replace unsafe chars
  const base = name.replace(/[\\/]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  return base.slice(0, 100);
}

function buildObjectPath(locationId, fileName) {
  const safeLocation = (locationId && typeof locationId === 'string')
    ? locationId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
    : 'unscoped';
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 10);
  return `${safeLocation}/${ts}-${rand}-${sanitizeFileName(fileName)}`;
}

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
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const bucket = process.env.SUPABASE_BUCKET;
  if (!supabaseUrl || !supabaseKey || !bucket) {
    console.error('[upload] Supabase env vars not configured');
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

  // 5. Upload to Supabase Storage via REST
  // ⚠️ SECURITY NOTE: SUPABASE_SERVICE_KEY lives only in env vars. Never log it.
  try {
    const buffer = Buffer.from(base64, 'base64');
    const objectPath = buildObjectPath(locationId, name);
    const encodedBucket = encodeURIComponent(bucket);
    const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
    const baseUrl = supabaseUrl.replace(/\/+$/, '');

    const uploadUrl = `${baseUrl}/storage/v1/object/${encodedBucket}/${encodedPath}`;

    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + supabaseKey,
        'Content-Type': type,
        'x-upsert': 'false',
        'Cache-Control': '3600'
      },
      body: buffer
    });

    const uploadBody = await uploadRes.text();

    if (!uploadRes.ok) {
      console.error('[upload] Supabase returned error:', uploadRes.status, uploadBody.slice(0, 300));
      return res.status(502).json({ error: 'Upload to Supabase failed', status: uploadRes.status });
    }

    const publicUrl = `${baseUrl}/storage/v1/object/public/${encodedBucket}/${encodedPath}`;

    console.log('[upload] Uploaded:', name, '→', objectPath);
    setCORSHeaders(res, corsOrigin);
    return res.status(200).json({ url: publicUrl, fileId: objectPath });

  } catch (err) {
    console.error('[upload] Proxy error:', err.message);
    return res.status(500).json({ error: 'Upload error' });
  }
}
