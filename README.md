# CoachG Support Portal

> AI-powered customer support system for COACHG Revenue OS agents.
> Built on Vercel (Node.js serverless) · Claude AI · GoHighLevel webhook integration.

---

## What This Is

A standalone support portal that lives as a **Custom Menu Link** inside each agent's GHL sub-account. Agents click it, get an AI triage bot that resolves ~60–70% of issues instantly, and can escalate to a support ticket or live Zoom with one message.

**No API keys in the browser. No GHL webhook URLs in the browser. Everything sensitive stays server-side.**

---

## Architecture

```
Agent clicks Custom Menu Link in GHL sidebar
        ↓
Vercel static → public/index.html (the portal UI)
        ↓  POST /api/chat
Vercel Function → Anthropic Claude API   ← ANTHROPIC_API_KEY (env var only)
        ↓  POST /api/support-webhook
Vercel Function → GHL Webhook URL        ← GHL_WEBHOOK_URL (env var only)
        ↓
GHL Workflow fires:
  → Create Opportunity in "COACHG Support Tickets" pipeline
  → Tag contact: support-open, support-[category]
  → Set custom fields: category, priority, description
  → SMS agent: ticket confirmation
  → Internal notification: support team
```

---

## Project Structure

```
CoachG-Support/
├── public/
│   └── index.html              ← Support portal UI (chat + ticket + Zoom tabs)
├── api/
│   ├── chat.js                 ← Anthropic API proxy (keeps API key server-side)
│   ├── support-webhook.js      ← GHL webhook proxy (keeps webhook URL server-side)
│   └── upload.js               ← Supabase Storage upload proxy (keeps service key server-side)
├── CLAUDE.md                   ← Claude Code session context (do not delete)
├── .env.example                ← Environment variable template
├── .gitignore                  ← Excludes .env.local, node_modules, .vercel
├── vercel.json                 ← Vercel routing + security headers config
├── package.json                ← Node.js project config
└── README.md                   ← This file
```

---

## Environment Variables

Set these in Vercel Dashboard → Project → Settings → Environment Variables.
Never commit actual values to the repo.

| Variable | Where to get it | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | ✅ |
| `GHL_WEBHOOK_URL` | GHL → Automation → Workflows → Webhook Trigger → copy URL | ✅ |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL | ✅ |
| `SUPABASE_SERVICE_KEY` | Supabase → Project Settings → API → `service_role` key | ✅ |
| `SUPABASE_BUCKET` | Storage bucket name (e.g. `Support Bucket`) | ✅ |
| `ALLOWED_ORIGIN` | Your Vercel deploy URL (e.g. `https://coachg-support.vercel.app`) | ✅ |

Copy `.env.example` to `.env.local` for local development:
```bash
cp .env.example .env.local
# then fill in real values in .env.local
```

---

## Deploy

### Prerequisites
- [Node.js 18+](https://nodejs.org)
- [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`
- [Git](https://git-scm.com)

### First Deploy

```bash
# 1. Clone the repo
git clone https://github.com/WebSynq/CoachG-Support.git
cd CoachG-Support

# 2. Install dependencies
npm install

# 3. Set up local env vars
cp .env.example .env.local
# Edit .env.local with your real keys

# 4. Run locally
vercel dev
# → http://localhost:3000

# 5. Deploy to production
vercel --prod
```

### CI/CD (Automatic via GitHub)
Every push to `main` triggers an automatic Vercel deploy.
Pull requests get preview deployments automatically.

---

## GHL Setup

### 1. Create the Support Ticket Workflow in GHL

**Trigger:** Webhook (Inbound)
Copy the webhook URL — this goes in `GHL_WEBHOOK_URL` env var.

**Workflow Actions:**
1. **Create Opportunity** → Pipeline: `COACHG Support Tickets` → Stage: `New Ticket`
2. **Add Tag** → `support-open`
3. **Add Tag** → Dynamic from `ticket.category` field
4. **Set Custom Field** → `support-issue-category` = `{{ticket.category}}`
5. **Set Custom Field** → `support-priority` = `{{ticket.priority}}`
6. **Set Custom Field** → `support-description` = `{{ticket.description}}`
7. **Send SMS** → Agent: `"Your ticket {{ticket.id}} has been received. We'll respond within 4 hours."`
8. **Internal Notification** → Support team: `"New ticket from {{contact.first_name}} — {{ticket.category}} | Priority {{ticket.priority}}"`

### 2. Add Custom Menu Link (per sub-account or via snapshot)

```
GHL Sub-Account → Settings → Custom Menu Links → Add New
  Name:    🎧 Support Center
  URL:     https://your-deploy-url.vercel.app
  Open in: iFrame
```

To deploy to all 79 sub-accounts at once: add the Custom Menu Link to your master GHL snapshot and push the snapshot update.

---

## Support Ticket Pipeline

Create this pipeline in GHL master account or dedicated support sub-account:

| Stage | Purpose |
|---|---|
| `📥 New Ticket` | Ticket created via portal |
| `🤖 AI Resolved` | Bot resolved, agent confirmed |
| `👀 Awaiting Response` | Assigned, team not yet responded |
| `🔧 In Progress` | Support team actively working |
| `📅 Zoom Scheduled` | Live call booked |
| `✅ Resolved` | Issue fixed |
| `🗄️ Closed` | Auto-closed after 7 days resolved |

---

## Custom Fields Required in GHL

| Field Name | Type | Purpose |
|---|---|---|
| `support-issue-category` | Dropdown | Platform/Tech, Billing, Training, Compliance, Other |
| `support-priority` | Dropdown | 1 (Low), 2 (Medium), 3 (High) |
| `support-description` | Text Area | Agent's description of the issue |
| `support-ticket-id` | Text | Auto-generated ticket ID |

---

## API Routes

### `POST /api/chat`
Proxies conversation to Anthropic Claude API. Keeps `ANTHROPIC_API_KEY` server-side.

**Request:**
```json
{ "messages": [{ "role": "user", "content": "My bot stopped responding" }] }
```

**Response:** Anthropic API response object.

**Rate limit:** 40 requests / hour / IP

---

### `POST /api/upload`
Uploads a base64-encoded image to Supabase Storage and returns a public URL. Keeps `SUPABASE_SERVICE_KEY` server-side.

**Request:**
```json
{
  "name": "screenshot.png",
  "type": "image/png",
  "base64": "iVBORw0KGgo...",
  "locationId": "ghl-subaccount-id"
}
```

**Response:**
```json
{
  "url": "https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>",
  "fileId": "<locationId>/<timestamp>-<rand>-<filename>"
}
```

Files are namespaced by `locationId` inside the bucket so uploads are scoped per GHL sub-account.

**Rate limit:** 20 requests / hour / IP · **Max size:** ~5MB · **Allowed types:** `image/*`

> The bucket must be set to **Public** in Supabase for the returned URL to resolve. For private buckets, switch the route to issue signed URLs instead.

---

### `POST /api/support-webhook`
Validates and proxies support events to GHL. Keeps `GHL_WEBHOOK_URL` server-side.

**Events:**
- `support.ticket.created` — fires when AI collects full ticket info
- `support.zoom.requested` — fires when AI escalates to live Zoom

**Request (ticket):**
```json
{
  "event": "support.ticket.created",
  "source": "coachg-support-portal",
  "ticket": {
    "id": "TKT-ABC123",
    "category": "Platform/Tech",
    "priority": 2,
    "description": "My AI bot stopped responding to leads after I updated the workflow."
  }
}
```

**Rate limit:** 10 requests / hour / IP

---

## Security

- All API keys and webhook URLs are **server-side only** — never in browser code
- Origin header validated on every API request against `ALLOWED_ORIGIN`
- Rate limiting on `/api/chat` (40/hr), `/api/support-webhook` (10/hr), and `/api/upload` (20/hr) per IP
- Input validation on all payloads before forwarding
- Security headers on all routes via `vercel.json`

> For production scale beyond ~79 users, swap the in-memory rate limiter for [Upstash Redis](https://upstash.com) — free tier covers this volume.

---

## Local Development

```bash
npm install
cp .env.example .env.local  # fill in your keys
vercel dev                   # runs functions + static at http://localhost:3000
```

---

## Contributing

Internal Web Synq project. All PRs require review before merge to `main`.

Branch naming:
- `feature/` — new features
- `fix/` — bug fixes
- `infra/` — Vercel/config/deployment changes

---

## Maintainer

Built by **Web Synq Design** for **COACHG / Gruening Health & Wealth**
Contact: Tim Arnold — Web Synq Design
