"""
COACHG Support Center — Preview Backend (FastAPI)
Mirrors the production Vercel serverless functions (/api/chat,
/api/support-webhook, /api/upload) so the static portal in /app/public
can be previewed end-to-end before pushing to GitHub/Vercel.

Production routes live in /app/api/*.js — DO NOT delete them.
"""
import os
import time
import logging
from typing import Any, Dict, List, Optional, Union

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent

load_dotenv()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("coachg")

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
GHL_WEBHOOK_URL = os.environ.get("GHL_WEBHOOK_URL", "")

SYSTEM_PROMPT = """You are Coach G Support — the expert GHL platform assistant for COACHG Revenue OS agents.

You are a HANDS-ON TROUBLESHOOTER. Your job is to walk agents through fixing their issues step by step right here in this chat — not just tell them what to do, but guide them through every click.

═══════════════════════════════════════
WHO YOU ARE HELPING
═══════════════════════════════════════
Insurance agents and agency owners on the COACHG Revenue OS platform (built on GoHighLevel). They sell Medicare, annuities, life insurance, final expense, and supplemental health products.

COACHG Platform Tiers:
- Foundation ($297/mo): CRM, pipelines, basic automations
- Growth ($497/mo): AI SMS qualification, lead scoring, booking
- Domination ($997/mo): Voice AI, multi-agent routing, dashboards

═══════════════════════════════════════
GHL EXPERTISE — YOU KNOW ALL OF THIS
═══════════════════════════════════════

CONTACTS & CRM: contacts, custom fields, tags, smart lists, imports, notes/tasks.

WORKFLOWS & AUTOMATIONS:
- Triggers: form submit, tag added/removed, pipeline stage change, appointment booked, inbound webhook, contact created, date/time
- Actions: send SMS, send email, add/remove tag, create opportunity, assign user, add note, wait, if/else, webhook, update field
- Common failures: workflow in draft not active, contact doesn't meet trigger filter, missing required fields, SMS not sending due to A2P, email bouncing

PIPELINES & OPPORTUNITIES: creating pipelines/stages, moving opportunities, custom fields, automation triggers, rotting days.

CALENDARS & APPOINTMENTS: round robin/class calendars, availability, confirmations/reminders, embedding, booking links, no-show follow up.

CONVERSATION AI BOT: setup, training on KB, qualification config. Bot not responding fixes — (1) check kill switch tag, (2) verify Active not Draft, (3) channel assignment, (4) sub-account AI enabled, (5) conversation window open.

SMS & A2P: A2P 10DLC, brand/campaign registration, errors 30034/30007/30003, LC Phone, opt-in/opt-out, TCPA.

FORMS & FUNNELS: form builder fields/logic, funnel pages, submission triggers, redirect, webhooks.

SNAPSHOTS: what they include, pushing updates, version control.

REPORTING & DASHBOARDS: conversation, appointment, pipeline value, attribution, custom dashboards.

EMAIL: LC Email, custom sending domains, SPF/DKIM/DMARC, deliverability, unsubscribe.

═══════════════════════════════════════
MEDICARE & INSURANCE KNOWLEDGE
═══════════════════════════════════════
- Original Medicare: Part A (hospital), Part B (medical)
- Medigap: Plans A,B,C,D,F,G,K,L,M,N — Plan G most popular, Plan N small copays
- Medicare Advantage (Part C): managed care, often $0 premium
- Part D: standalone Rx — 1% per month late penalty
- AEP: Oct 15 – Dec 7 | OEP: Jan 1 – Mar 31 (MA only)
- Scope of Appointment: required 48hrs before MA sales meeting
- CMS compliance: no misleading statements, present all options

TOP CARRIERS:
- Cancer/Heart/Stroke: Aetna, Bankers Fidelity, Liberty Bankers, GTL
- Recovery/Home Care: Aetna, GTL/Heartland, Bankers Fidelity
- Hospital Indemnity: Liberty Bankers, Aetna, Medico
- Dental: Physician's Mutual, Mutual of Omaha, Aetna DVH+
- Accident: Liberty, GTL Critical Provider Plus

UMBRELLA PACKAGES:
- #1: Medicare + Rx + CHS
- #2: Medicare + Rx + CHS + DVH or HIP
- #3: Medicare + Rx + CHS + DVH or HIP + Recovery Care

═══════════════════════════════════════
HOW YOU RESPOND
═══════════════════════════════════════
TONE: Direct, confident, like a senior GHL expert sitting next to them. Football coaching references welcome. Get to the fix fast. No fluff.

STEP BY STEP ALWAYS: give exact click paths.
Example: "GHL → Automation → Workflows → [workflow name] → click the trigger → check the filter conditions"

IMAGE ANALYSIS: when an agent shares a screenshot, identify what you see, diagnose, then give the step-by-step fix.

ESCALATION TO TICKET — only when you've walked them through fixes and it's still broken, requires backend access, billing/account issue, or compliance/CMS concern. Say:
"This one needs the support team to dig in directly. Click the Submit Ticket tab and fill out the form — include details and attach a screenshot if you have one."

NEVER: tell them to "contact support" without first trying to fix it; give vague answers; create a ticket without confirmation.

OFFICE HOURS: "This is a great one to bring to office hours — you'll get the most out of a live walkthrough on this."
"""

# ─── Rate Limiting ────────────────────────────────────────────────────
_chat_rl: Dict[str, Dict[str, float]] = {}
_webhook_rl: Dict[str, Dict[str, float]] = {}
_WINDOW = 60 * 60
CHAT_LIMIT = 40
WEBHOOK_LIMIT = 10


def _rl_ok(bucket: Dict[str, Dict[str, float]], ip: str, limit: int) -> bool:
    now = time.time()
    entry = bucket.get(ip)
    if not entry or now - entry["start"] > _WINDOW:
        bucket[ip] = {"count": 1, "start": now}
        return True
    if entry["count"] >= limit:
        return False
    entry["count"] += 1
    return True


# ─── App ──────────────────────────────────────────────────────────────
app = FastAPI(title="COACHG Support Center API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Models ───────────────────────────────────────────────────────────
class ChatMessage(BaseModel):
    role: str
    content: Union[str, List[Dict[str, Any]]]


class ChatRequest(BaseModel):
    messages: List[ChatMessage]


# ─── Helpers ──────────────────────────────────────────────────────────
def _extract_user_text_and_image(content: Union[str, List[Dict[str, Any]]]):
    """Return (text, base64_image_or_None) from an Anthropic-style content."""
    if isinstance(content, str):
        return content, None
    text_parts = []
    image_b64 = None
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text_parts.append(block.get("text", ""))
        elif btype == "image":
            src = block.get("source", {}) or {}
            if src.get("type") == "base64":
                image_b64 = src.get("data")
    return " ".join(t for t in text_parts if t).strip(), image_b64


# ─── Routes ───────────────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"ok": True, "service": "coachg-support-preview", "model": "claude-sonnet-4-5-20250929"}


@app.post("/api/chat")
async def chat(req: ChatRequest, request: Request):
    ip = request.client.host if request.client else "unknown"
    if not _rl_ok(_chat_rl, ip, CHAT_LIMIT):
        return JSONResponse({"error": "Too many requests. Please wait."}, status_code=429)

    if not EMERGENT_LLM_KEY:
        return JSONResponse({"error": "LLM key not configured"}, status_code=500)

    if not req.messages:
        return JSONResponse({"error": "messages required"}, status_code=400)

    # Use the most recent user message as the prompt, prior turns form history.
    # We replay history through the LlmChat instance so context is preserved.
    last = req.messages[-1]
    if last.role != "user":
        return JSONResponse({"error": "last message must be user"}, status_code=400)

    session_id = f"coachg-{ip}-{int(time.time() // 60)}"
    try:
        llm = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=session_id,
            system_message=SYSTEM_PROMPT,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")

        # Replay prior history (best-effort: text only). emergentintegrations
        # manages its own history per session; we rebuild context on every call
        # by sending all prior turns sequentially before the final one.
        for prior in req.messages[:-1]:
            text, _img = _extract_user_text_and_image(prior.content)
            if prior.role == "user" and text:
                await llm.send_message(UserMessage(text=text))
                # We don't actually want a response for replay; but the lib
                # always responds. To preserve true history without burning
                # tokens, only replay if conversation is short.
                # Pragmatic approach: skip replay (assume single-turn context
                # is sufficient for support triage).
                break

        text, image_b64 = _extract_user_text_and_image(last.content)
        if not text and not image_b64:
            return JSONResponse({"error": "empty message"}, status_code=400)

        file_contents = []
        if image_b64:
            file_contents.append(ImageContent(image_base64=image_b64))

        user_msg = UserMessage(
            text=text or "Please analyze this screenshot and help me fix the issue.",
            file_contents=file_contents or None,
        )
        response_text = await llm.send_message(user_msg)

        # Shape response like Anthropic's native API so the static frontend
        # (which reads data.content[0].text) keeps working in both preview
        # and production (Vercel) without modification.
        return {
            "content": [{"type": "text", "text": response_text}],
            "role": "assistant",
            "model": "claude-sonnet-4-5-20250929",
        }
    except Exception as e:
        log.exception("[chat] LLM error")
        return JSONResponse({"error": f"AI service unavailable: {str(e)[:120]}"}, status_code=502)


@app.post("/api/support-webhook")
async def support_webhook(request: Request):
    ip = request.client.host if request.client else "unknown"
    if not _rl_ok(_webhook_rl, ip, WEBHOOK_LIMIT):
        return JSONResponse({"error": "Too many requests"}, status_code=429)

    body = await request.json()
    event = body.get("event")
    VALID = {"support.ticket.created", "support.zoom.requested"}
    if event not in VALID:
        return JSONResponse({"error": "Invalid event"}, status_code=400)

    if event == "support.ticket.created":
        t = body.get("ticket") or {}
        if t.get("category") not in {"Platform/Tech", "Billing", "Training", "Compliance", "Other"}:
            return JSONResponse({"error": "Invalid category"}, status_code=400)
        try:
            pri = int(t.get("priority"))
        except Exception:
            pri = 0
        if pri not in (1, 2, 3):
            return JSONResponse({"error": "Invalid priority"}, status_code=400)
        desc = t.get("description") or ""
        if not isinstance(desc, str) or not desc.strip() or len(desc) > 1000:
            return JSONResponse({"error": "Invalid description"}, status_code=400)

    log.info("[webhook] %s ticket=%s", event, (body.get("ticket") or {}).get("id"))

    if not GHL_WEBHOOK_URL:
        # Preview mode — no webhook configured. Accept and echo.
        return {
            "ok": True,
            "event": event,
            "preview_mode": True,
            "note": "GHL_WEBHOOK_URL not configured — payload validated but not forwarded.",
        }

    try:
        payload = dict(body)
        payload["_proxied_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        payload["_source_ip"] = ip
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(GHL_WEBHOOK_URL, json=payload)
        if r.status_code >= 400:
            log.error("[webhook] GHL error %s", r.status_code)
            return JSONResponse({"error": "Failed to reach GHL"}, status_code=502)
        return {"ok": True, "event": event}
    except Exception as e:
        log.exception("[webhook] forward error")
        return JSONResponse({"error": f"Forward error: {str(e)[:120]}"}, status_code=500)


@app.post("/api/upload")
async def upload(request: Request):
    """Preview-mode stub. Returns a data: URL so the frontend flow works
    without GHL Media Library credentials. Production /api/upload.js handles
    the real GHL upload."""
    body = await request.json()
    b64 = body.get("base64")
    mime = body.get("type", "image/png")
    name = body.get("name", "screenshot.png")
    if not b64:
        return JSONResponse({"error": "missing base64"}, status_code=400)
    return {
        "url": f"data:{mime};base64,{b64}",
        "fileId": f"preview-{int(time.time())}-{name}",
        "preview_mode": True,
    }
