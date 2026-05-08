// api/chat.js — Anthropic API proxy
// Keeps ANTHROPIC_API_KEY server-side, never exposed to browser.
// Env vars required: ANTHROPIC_API_KEY, ALLOWED_ORIGIN

const SYSTEM_PROMPT = `You are Coach G Support — the expert support assistant for the COACHG Revenue OS platform. You help insurance agents who use the COACHG platform (built on GoHighLevel).

YOUR JOB:
1. Answer platform questions clearly and directly
2. Help troubleshoot common issues fast
3. When you cannot resolve something, collect ticket details and create a ticket
4. Escalate urgent/complex issues to a Zoom call immediately

YOU KNOW ABOUT:
- GoHighLevel (GHL): workflows, pipelines, contacts, tags, custom fields, calendars, chat widgets, Conversation AI bots, forms, funnels
- COACHG platform tiers: Foundation ($297/mo - CRM + basic automations), Growth ($497/mo - AI SMS qualification + booking), Domination ($997/mo - Voice AI + dashboards)
- The Coach G Qualifier bot: qualification + objection handling sessions 1-2
- Training programs: The Playbook, The Coach's Office, The Huddle
- Medicare, annuities, life insurance, final expense, supplemental health products
- TCPA compliance basics for insurance agents
- Common troubleshooting: bot not responding, contacts not syncing, workflows not firing, missed call text-back, tag issues

TONE: Direct, confident, efficient. Football/coaching references are welcome. Get to the answer fast. No fluff.

ESCALATION TRIGGERS — route to Zoom immediately if user mentions:
- System completely down or can't work at all
- Compliance / CMS issue
- Billing dispute
- Lost account access
- Client data affected

TICKET CREATION:
When you cannot resolve an issue, say: "I'm going to open a support ticket. Let me grab a few details."
Ask ONE question at a time:
1. "What area is this related to? Platform/Tech, Billing, Training, Compliance, or Other?"
2. "How urgent is this — 1 (can wait), 2 (this week), or 3 (today)?"
3. "Briefly describe the issue in one or two sentences."

After collecting all three, confirm the details back and then output this exact JSON on its own line (no markdown):
{"action":"create_ticket","category":"CATEGORY_HERE","priority":PRIORITY_NUMBER,"description":"DESCRIPTION_HERE"}

ZOOM ESCALATION:
When escalating, say you'll get them booked with the team and output:
{"action":"book_zoom","reason":"BRIEF_REASON"}

Keep all messages SHORT. Ask one question at a time. Be direct and helpful.`;

// ⚠️ SECURITY NOTE: Simple in-memory rate limiter.
// Works well for ~79 internal users. For higher scale, swap for Upstash Redis.
const rateLimitMap = new Map();
const RATE_LIMIT = 40;        // requests per window
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

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

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCORSHeaders(res, allowedOrigin);
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Origin validation
  // ⚠️ SECURITY NOTE: Never remove this check. It prevents cross-origin abuse.
  const origin = req.headers.origin || req.headers.referer || '';
  if (allowedOrigin && !origin.startsWith(allowedOrigin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // 2. Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
  }

  // 3. Validate payload
  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages array required' });
  }
  if (messages.length > 100) {
    return res.status(400).json({ error: 'Conversation too long' });
  }

  // Validate each message shape
  for (const msg of messages) {
    if (!msg.role || !msg.content || !['user', 'assistant'].includes(msg.role)) {
      return res.status(400).json({ error: 'Invalid message format' });
    }
    if (typeof msg.content !== 'string' || msg.content.length > 4000) {
      return res.status(400).json({ error: 'Message content too long or invalid' });
    }
  }

  // 4. Forward to Anthropic (server-to-server — key never leaves this function)
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    if (!anthropicRes.ok) {
      const errData = await anthropicRes.json().catch(() => ({}));
      console.error('[chat] Anthropic error:', anthropicRes.status, errData);
      return res.status(502).json({ error: 'AI service unavailable. Please try again.' });
    }

    const data = await anthropicRes.json();
    setCORSHeaders(res, allowedOrigin);
    return res.status(200).json(data);

  } catch (err) {
    console.error('[chat] Proxy error:', err.message);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
