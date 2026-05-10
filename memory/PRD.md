# COACHG Support Center — PRD

## Original Problem Statement
"Lets build a more immersive looking application for the customer, this is an app for ghl customers to get support on, they can chat back and forth with the ai agent and get their issues solved, this also has a form where they can submit a ticket if necessary. let me know what we could do to make this better, can you build me a preview first before writing anything to github."

## Product
Support portal for COACHG Revenue OS — used by ~79 insurance agent sub-accounts on GoHighLevel. Embedded as a Custom Menu Link iFrame inside each agent's GHL sidebar. AI triage chat resolves ~70% of issues instantly; remainder routes to a ticket pipeline via GHL webhook.

## User Persona
Insurance agents (Medicare, annuities, life, final expense). Long working hours, in-and-out of GHL all day. Need fast, expert answers and a clean way to escalate when AI can't help.

## Architecture (preserved — production stays on Vercel)
```
public/index.html       ← Static portal (now redesigned, immersive)
api/chat.js             ← Production Vercel function → Anthropic API
api/support-webhook.js  ← Production Vercel function → GHL webhook
api/upload.js           ← Production Vercel function → GHL Media Library
```

Preview-only (added for the Emergent preview environment, not pushed to Vercel):
```
backend/server.py       ← FastAPI mirror of /api/* using Emergent LLM Key
backend/.env, requirements.txt
frontend/server.js      ← Express static server for public/index.html on :3000
frontend/package.json
```

## Core Requirements (static)
- AI chat with Claude Sonnet 4.5, full GHL + Medicare + COACHG playbook context
- Image/screenshot upload in chat (base64 → vision)
- Ticket form (name/email/account fields cached in localStorage)
- Webhook into GHL "COACHG Support Tickets" pipeline
- Must render inside GHL iFrame (no fixed-position modals, no window.top)
- Single static HTML — no build step

## What's Been Implemented (this session — 2026-01-10)
- ✅ **Complete immersive UI redesign** of `public/index.html`
  - Deep-navy ambient backdrop with layered radial gradients + subtle grid texture
  - Glassmorphism header + sidebar (`backdrop-blur-xl` over `#0A101D/70`)
  - Gold gradient logo mark + Bebas Neue display type with gold-gradient text fill
  - Pulsing "AI Online" heartbeat indicator
  - Gold-gradient user bubbles + dark AI bubbles with gold left-accent border
  - Pill-shaped quick-action chips with lift-on-hover micro-motion
  - Sleek floating chat input dock with focus glow ring
  - Custom typing indicator (3 pulsing gold dots)
  - Typography: Bebas Neue (display) + DM Sans (body) + JetBrains Mono (meta)
  - Tab system with animated gold underline
  - Stylized form fields with gold focus rings
  - Animated success state for submitted tickets (popIn keyframe + gradient check icon)
  - Custom thin scrollbar with gold hover state
  - Full `data-testid` coverage on interactive elements
- ✅ **Preview backend** (`backend/server.py` FastAPI) mirrors all 3 Vercel routes
  - `/api/chat` — Claude Sonnet 4.5 via emergentintegrations + vision support
  - `/api/support-webhook` — full payload validation, optional GHL forwarding
  - `/api/upload` — preview stub returning data: URLs (production uses GHL Media)
- ✅ **Preview frontend wrapper** — minimal Express server serving the static HTML
- ✅ **Production /api/*.js Vercel functions left untouched** — clean GitHub push

## Known Preview Notes
- `GHL_WEBHOOK_URL` is empty in `backend/.env` → webhook returns `{"ok": true, "preview_mode": true}` instead of actually firing to GHL. Production Vercel uses the real `GHL_WEBHOOK_URL`. **(MOCKED in preview only)**
- `/api/upload` in preview returns a base64 `data:` URL. Production uses real GHL Media Library upload. **(MOCKED in preview only)**

## Backlog (next iterations — pending user approval)
- [ ] **P0** — User reviews preview & approves design → push to GitHub
- [ ] **P1** — Pass GHL contact data (name, email) into webhook payload via URL params (auto-fill from iFrame query string)
- [ ] **P1** — Zoom calendar URL integration (replace placeholder)
- [ ] **P2** — Voice input (Web Speech API mic button)
- [ ] **P2** — Conversation history persistence per agent
- [ ] **P2** — Upstash Redis rate limiter (scale > 79 agents)
- [ ] **P2** — GHL OAuth context (sub-account identity baked into iFrame)
- [ ] **P3** — Dark/Light theme toggle (default dark, premium light option)
- [ ] **P3** — Multi-language support (Spanish-speaking agents)
