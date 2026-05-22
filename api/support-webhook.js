// api/support-webhook.js — GHL webhook proxy
// Keeps GHL_WEBHOOK_URL server-side, validates payload, forwards to GHL.
// Env vars required: GHL_WEBHOOK_URL, ALLOWED_ORIGINS (comma-separated) or ALLOWED_ORIGIN

// ⚠️ SECURITY NOTE: Simple in-memory rate limiter — adequate for 79 internal users.
const rateLimitMap = new Map();
const RATE_LIMIT = 10;
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

const VALID_EVENTS = ['support.ticket.created', 'support.zoom.requested'];
const VALID_CATEGORIES = ['Platform/Tech', 'Billing', 'Training', 'Compliance', 'Other'];

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

  // 2. Rate limit — tighter than chat since this creates GHL records
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // 3. Validate GHL webhook URL is configured
  if (!process.env.GHL_WEBHOOK_URL) {
    console.error('[webhook] GHL_WEBHOOK_URL not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  // 4. Validate payload structure
  const body = req.body || {};

  if (!body.event || !VALID_EVENTS.includes(body.event)) {
    return res.status(400).json({ error: 'Invalid or missing event type' });
  }

  if (body.event === 'support.ticket.created') {
    const { ticket, contact, account } = body;
    if (!ticket) return res.status(400).json({ error: 'Missing ticket data' });
    if (!ticket.category || !VALID_CATEGORIES.includes(ticket.category)) {
      return res.status(400).json({ error: 'Invalid ticket category' });
    }
    if (!ticket.priority || ![1, 2, 3].includes(Number(ticket.priority))) {
      return res.status(400).json({ error: 'Invalid ticket priority' });
    }
    if (!ticket.description || typeof ticket.description !== 'string' || ticket.description.length > 1000) {
      return res.status(400).json({ error: 'Invalid ticket description' });
    }
    if (!contact || typeof contact !== 'object') {
      return res.status(400).json({ error: 'Missing contact data' });
    }
    if (!contact.firstName || !contact.lastName || !contact.email) {
      return res.status(400).json({ error: 'Contact requires firstName, lastName, and email' });
    }
    if (!account || typeof account !== 'object') {
      console.warn('[webhook] account object missing — proceeding anyway');
    }
  }

  // 5. Forward to GHL — server-to-server only
  // ⚠️ SECURITY NOTE: GHL_WEBHOOK_URL lives only in env vars. Never log it.
  try {
    const ghlRes = await fetch(process.env.GHL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        _proxied_at: new Date().toISOString(),
        _source_ip: ip
      })
    });

    if (!ghlRes.ok) {
      console.error('[webhook] GHL returned error:', ghlRes.status);
      return res.status(502).json({ error: 'Failed to reach GHL' });
    }

    console.log('[webhook] Fired:', body.event, body.ticket?.id || '');
    setCORSHeaders(res, corsOrigin);
    return res.status(200).json({ ok: true, event: body.event });

  } catch (err) {
    console.error('[webhook] Proxy error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
}
