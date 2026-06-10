"""
Gaura Telegram Bot — FastAPI webhook server.

GROUP MODE (default):
  - Bot is added to a group with you (admin) + interviewee
  - Admin registers the session with /setup <session_id>
  - Interviewee joins and sends /start to begin
  - Admin can send /pause /skip /end to control without the bot responding
  - Bot only replies to the confirmed interviewee

DM MODE (future):
  - Set INTERVIEW_MODE=dm in config
  - Bot messages the interviewee directly via their chat_id
  - Same interview logic, no group needed
"""

import json
import httpx
import logging
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

import config
import storage
import interview

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="Gaura Telegram Bot")

# ── CORS — allow requests from claude.ai and any local dev origin ─────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # allow all origins (including claude.ai artifacts)
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

TELEGRAM_API = "https://api.telegram.org/bot" + config.TELEGRAM_TOKEN


# ── Telegram helpers ──────────────────────────────────────────────────────────

async def tg(method: str, **kwargs):
    """Call a Telegram Bot API method."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(f"{TELEGRAM_API}/{method}", json=kwargs)
        data = resp.json()
        if not data.get("ok"):
            log.warning("Telegram API error: %s", data)
        return data


async def send(chat_id: int, text: str, reply_to: int = None):
    kwargs = {"chat_id": chat_id, "text": text, "parse_mode": "Markdown"}
    if reply_to:
        kwargs["reply_to_message_id"] = reply_to
    await tg("sendMessage", **kwargs)


async def send_typing(chat_id: int):
    await tg("sendChatAction", chat_id=chat_id, action="typing")


# ── Session lookup helpers ────────────────────────────────────────────────────

def find_session_for_group(chat_id: int) -> tuple[str, dict] | tuple[None, None]:
    """Find the active session for a given group chat_id."""
    for sid in storage.list_sessions():
        sess = storage.load_session(sid)
        if sess and sess.get("group_chat_id") == chat_id and sess.get("status") in ("pending", "active"):
            return sid, sess
    return None, None


def find_session_by_id(session_id: str) -> dict | None:
    return storage.load_session(session_id)


# ── Command handlers ──────────────────────────────────────────────────────────

async def handle_setup(chat_id: int, user_id: int, args: list[str]):
    """
    /setup <session_id>
    Admin command — registers this group chat with a session.
    Run this first after adding the bot to the group.
    """
    if not args:
        await send(chat_id, "Usage: `/setup <session_id>`")
        return

    session_id = args[0]
    sess = find_session_by_id(session_id)
    if not sess:
        await send(chat_id, f"Session `{session_id}` not found. Generate it from Gaura first.")
        return

    sess["group_chat_id"] = chat_id
    sess["admin_user_id"]  = user_id
    storage.save_session(session_id, sess)

    name = sess.get("interviewee_name", "the interviewee")
    q_count = len(sess.get("guide", {}).get("questions", []))
    await send(
        chat_id,
        f"✅ *Session registered.*\n\n"
        f"Interview with *{name}* is ready.\n"
        f"Guide: {q_count} questions.\n\n"
        f"Ask {name} to join this group and send `/start` to begin.\n"
        f"You can use these commands at any time:\n"
        f"`/pause` — pause the interview\n"
        f"`/resume` — resume after a pause\n"
        f"`/skip` — move to the next guide question\n"
        f"`/end` — end the interview and generate the report"
    )


async def handle_start(chat_id: int, user_id: int, username: str):
    """
    /start
    Interviewee sends this to begin. Bot confirms them and opens the interview.
    """
    sid, sess = find_session_for_group(chat_id)
    if not sess:
        await send(chat_id, "No active session found for this group. Ask the admin to run `/setup` first.")
        return

    # Don't let the admin trigger /start
    if user_id == sess.get("admin_user_id"):
        await send(chat_id, "You are the session admin. Ask the interviewee to send `/start`.")
        return

    # Register interviewee
    sess["interviewee_user_id"] = user_id
    sess["status"] = "active"
    storage.save_session(sid, sess)

    await send_typing(chat_id)

    # Get the opening message from Claude
    reply = await interview.get_next_message(sess)

    # Store the opening turn
    sess["history"].append({"role": "assistant", "text": reply})
    storage.save_session(sid, sess)

    await send(chat_id, reply)


async def handle_skip(chat_id: int, user_id: int):
    """
    /skip — admin skips to the next guide question.
    """
    sid, sess = find_session_for_group(chat_id)
    if not sess:
        return
    if user_id != sess.get("admin_user_id"):
        return  # silently ignore non-admin

    questions = sess.get("guide", {}).get("questions", [])
    q_index   = sess.get("question_index", 0)

    if q_index >= len(questions) - 1:
        await send(chat_id, "_Admin: already on the last question._")
        return

    sess["question_index"] = q_index + 1
    storage.save_session(sid, sess)
    next_q = questions[sess["question_index"]]
    await send(chat_id, f"_Admin skipped to next question._\n\n{next_q}")


async def handle_pause(chat_id: int, user_id: int):
    sid, sess = find_session_for_group(chat_id)
    if not sess or user_id != sess.get("admin_user_id"):
        return
    sess["status"] = "paused"
    storage.save_session(sid, sess)
    await send(chat_id, "_Interview paused by admin. Send /resume to continue._")


async def handle_resume(chat_id: int, user_id: int):
    sid, sess = find_session_for_group(chat_id)
    if not sess or user_id != sess.get("admin_user_id"):
        return
    sess["status"] = "active"
    storage.save_session(sid, sess)
    await send(chat_id, "_Interview resumed._")


async def handle_end(chat_id: int, user_id: int):
    """
    /end — admin ends the interview early and generates the report.
    """
    sid, sess = find_session_for_group(chat_id)
    if not sess or user_id != sess.get("admin_user_id"):
        return
    await finish_interview(sid, sess, chat_id, early=True)


async def handle_status(chat_id: int):
    """
    /status — show current session state. Useful for debugging.
    """
    sid, sess = find_session_for_group(chat_id)
    if not sess:
        await send(chat_id, "No active session in this group.")
        return
    questions = sess.get("guide", {}).get("questions", [])
    q_index   = sess.get("question_index", 0)
    turns     = len(sess.get("history", []))
    await send(
        chat_id,
        f"*Session:* `{sid}`\n"
        f"*Status:* {sess.get('status')}\n"
        f"*Interviewee:* {sess.get('interviewee_name')}\n"
        f"*Progress:* Q{q_index + 1} of {len(questions)}\n"
        f"*Turns:* {turns}"
    )


# ── Core reply logic ──────────────────────────────────────────────────────────

async def handle_reply(chat_id: int, user_id: int, text: str, message_id: int):
    """Process an interviewee reply and generate the next question."""
    sid, sess = find_session_for_group(chat_id)
    if not sess:
        return

    # Only respond to the confirmed interviewee
    if user_id != sess.get("interviewee_user_id"):
        return

    # Ignore if paused
    if sess.get("status") == "paused":
        return

    # Add user reply to history
    sess["history"].append({"role": "user", "text": text})

    # Advance question index if they've given enough replies on current question
    if interview.should_advance_question(sess, text):
        sess["question_index"] = min(
            sess.get("question_index", 0) + 1,
            len(sess.get("guide", {}).get("questions", [])) - 1
        )

    storage.save_session(sid, sess)
    await send_typing(chat_id)

    # Get Claude's next message
    reply = await interview.get_next_message(sess)
    sess["history"].append({"role": "assistant", "text": reply})
    storage.save_session(sid, sess)

    await send(chat_id, reply)

    # Check if interview is naturally complete
    if interview.is_interview_complete(sess):
        await finish_interview(sid, sess, chat_id, early=False)


async def finish_interview(sid: str, sess: dict, chat_id: int, early: bool = False):
    """Generate the insight report and notify the group."""
    sess["status"] = "complete"
    storage.save_session(sid, sess)

    msg = "_Interview ended by admin._\n\n" if early else "_Interview complete._\n\n"
    await send(chat_id, msg + "Generating insight report...")
    await send_typing(chat_id)

    try:
        report = await interview.generate_insight_report(sess)
        sess["report"] = report
        storage.save_session(sid, sess)

        # Post a summary to the group
        summary = report.get("summary", "")
        insights = report.get("insights", [])
        actions  = report.get("actions", [])
        confidence = report.get("confidence", "")

        report_text = (
            f"*Interview complete — Insight Report*\n\n"
            f"*Summary:*\n{summary}\n\n"
        )
        if insights:
            report_text += "*Key insights:*\n"
            for ins in insights[:3]:
                report_text += f"• *{ins.get('title','')}: * {ins.get('detail','')}\n"
            report_text += "\n"
        if actions:
            report_text += "*Recommended actions:*\n"
            for i, a in enumerate(actions[:3], 1):
                report_text += f"{i}. {a.get('action','')} — {a.get('owner','')} ({a.get('timeline','')})\n"
        report_text += f"\n_Confidence: {confidence}%_"

        await send(chat_id, report_text)
        await send(
            chat_id,
            f"_Full report saved. Session ID: `{sid}`_\n"
            f"_Open Gaura to view the complete insights._"
        )

    except Exception as e:
        log.error("Report generation failed: %s", e)
        await send(chat_id, "Report generation failed. Transcript has been saved — you can generate the report manually in Gaura.")


# ── Webhook endpoint ──────────────────────────────────────────────────────────

@app.post("/webhook/{secret}")
async def webhook(secret: str, request: Request):
    if secret != config.WEBHOOK_SECRET:
        raise HTTPException(status_code=403, detail="Invalid secret")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    message = body.get("message") or body.get("edited_message")
    if not message:
        return JSONResponse({"ok": True})

    chat_id    = message["chat"]["id"]
    user_id    = message.get("from", {}).get("id")
    username   = message.get("from", {}).get("username", "")
    text       = message.get("text", "").strip()
    message_id = message.get("message_id")

    if not text:
        return JSONResponse({"ok": True})

    # Route commands
    if text.startswith("/"):
        parts   = text.split()
        command = parts[0].split("@")[0].lower()  # strip @botname suffix
        args    = parts[1:]

        if   command == "/setup":  await handle_setup(chat_id, user_id, args)
        elif command == "/start":  await handle_start(chat_id, user_id, username)
        elif command == "/skip":   await handle_skip(chat_id, user_id)
        elif command == "/pause":  await handle_pause(chat_id, user_id)
        elif command == "/resume": await handle_resume(chat_id, user_id)
        elif command == "/end":    await handle_end(chat_id, user_id)
        elif command == "/status": await handle_status(chat_id)
    else:
        # Regular message — treat as interviewee reply
        await handle_reply(chat_id, user_id, text, message_id)

    return JSONResponse({"ok": True})


# ── Session creation endpoint (called by Gaura platform) ─────────────────────

@app.post("/create-session")
async def create_session(request: Request):
    """
    Called by the Gaura platform when the user clicks 'Send via Telegram'.
    Body: { campaign_id, interviewee_name, interviewee_role, guide, config }
    Returns: { session_id, bot_link }
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    sess = storage.new_session(
        campaign_id        = body["campaign_id"],
        interviewee_name   = body["interviewee_name"],
        interviewee_role   = body.get("interviewee_role", ""),
        guide              = body["guide"],
        config             = body.get("config", {}),
        mode               = body.get("mode", config.INTERVIEW_MODE),
    )
    storage.save_session(sess["session_id"], sess)

    bot_info = await tg("getMe")
    bot_username = bot_info.get("result", {}).get("username", "GauraBot")

    return JSONResponse({
        "session_id": sess["session_id"],
        "bot_link": f"https://t.me/{bot_username}",
        "setup_command": f"/setup {sess['session_id']}",
        "instructions": (
            f"1. Add @{bot_username} to your Telegram group\n"
            f"2. Send: /setup {sess['session_id']}\n"
            f"3. Ask {sess['interviewee_name']} to join and send /start"
        )
    })


# ── Session report retrieval (called by Gaura platform) ──────────────────────

@app.get("/session/{session_id}/report")
async def get_report(session_id: str):
    sess = storage.load_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    report = sess.get("report")
    if not report:
        raise HTTPException(status_code=404, detail="Report not yet generated")
    return JSONResponse({
        "session_id": session_id,
        "interviewee_name": sess.get("interviewee_name"),
        "status": sess.get("status"),
        "report": report,
        "transcript": sess.get("history", []),
    })


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "mode": config.INTERVIEW_MODE}


# ── Register webhook (run once) ───────────────────────────────────────────────

@app.on_event("startup")
async def register_webhook():
    if not config.BASE_URL or not config.TELEGRAM_TOKEN:
        log.warning("BASE_URL or TELEGRAM_TOKEN not set — webhook not registered")
        return
    url = f"{config.BASE_URL}/webhook/{config.WEBHOOK_SECRET}"
    result = await tg("setWebhook", url=url, allowed_updates=["message"])
    if result.get("ok"):
        log.info("Webhook registered: %s", url)
    else:
        log.warning("Webhook registration failed: %s", result)


# ── Session creator page (opened in new tab from Gaura) ───────────────────────
# This page is opened by the user in a new browser tab.
# It receives session params via query string, creates the session,
# and shows the setup command — no iframe restrictions.

from fastapi.responses import HTMLResponse
from urllib.parse import unquote

@app.get("/create", response_class=HTMLResponse)
async def create_page(
    campaign_id: str = "",
    name: str = "",
    role: str = "",
    tone: str = "Conversational",
    depth: str = "Deep",
    length: str = "standard",
):
    name    = unquote(name)
    role    = unquote(role)
    safe_n  = name.replace("'", "\\'")
    safe_r  = role.replace("'", "\\'")

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Gaura — Create Interview Session</title>
  <style>
    * {{ box-sizing:border-box; margin:0; padding:0; }}
    body {{ font-family:-apple-system,'Segoe UI',sans-serif; background:#F9FAFB;
            display:flex; align-items:center; justify-content:center;
            min-height:100vh; padding:24px; }}
    .card {{ background:#fff; border:1px solid #E5E7EB; border-radius:14px;
             padding:32px; max-width:480px; width:100%;
             box-shadow:0 4px 24px rgba(0,0,0,0.08); }}
    .logo {{ width:36px; height:36px; background:#1a1a2e; border-radius:9px;
             display:flex; align-items:center; justify-content:center;
             font-weight:700; color:#fff; font-size:16px; margin-bottom:16px; }}
    h1 {{ font-size:18px; color:#111827; margin-bottom:4px; }}
    .sub {{ font-size:13px; color:#6B7280; margin-bottom:24px; }}
    .field {{ margin-bottom:16px; }}
    .field label {{ font-size:11px; font-weight:600; color:#6B7280;
                    text-transform:uppercase; letter-spacing:0.4px;
                    display:block; margin-bottom:5px; }}
    .field input {{ width:100%; border:1px solid #E5E7EB; border-radius:8px;
                    padding:9px 12px; font-size:13px; color:#111827;
                    outline:none; background:#F9FAFB; }}
    .btn {{ width:100%; background:#1a1a2e; color:#fff; border:none;
            border-radius:9px; padding:12px; font-size:14px; font-weight:600;
            cursor:pointer; margin-top:8px; }}
    .btn:disabled {{ opacity:0.5; cursor:not-allowed; }}
    .result {{ display:none; margin-top:24px; padding:16px;
               background:#F0FDF4; border:1px solid #BBF7D0; border-radius:10px; }}
    .result h3 {{ font-size:13px; font-weight:600; color:#0F6E56; margin-bottom:12px; }}
    .steps {{ font-size:12px; color:#374151; line-height:1.9; margin-bottom:12px; white-space:pre-wrap; }}
    .cmd-row {{ display:flex; gap:8px; }}
    .cmd {{ flex:1; font-family:monospace; font-size:11px; background:#fff;
             border:1px solid #BBF7D0; border-radius:6px; padding:8px 10px;
             color:#1a1a2e; outline:none; cursor:text; }}
    .copy-btn {{ background:#0F6E56; color:#fff; border:none; border-radius:6px;
                 padding:8px 14px; font-size:11px; font-weight:600; cursor:pointer;
                 white-space:nowrap; }}
    .error {{ display:none; margin-top:16px; padding:12px; background:#FEF2F2;
              border:1px solid #FECACA; border-radius:8px; font-size:12px; color:#DC2626; }}
    .spinner {{ display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,0.3);
                border-top-color:#fff; border-radius:50%; animation:spin 0.7s linear infinite;
                vertical-align:middle; margin-right:6px; }}
    @keyframes spin {{ to {{ transform:rotate(360deg); }} }}
  </style>
</head>
<body>
<div class="card">
  <div class="logo">G</div>
  <h1>Create interview session</h1>
  <p class="sub">This will register a Telegram interview session for this interviewee.</p>

  <div class="field">
    <label>Interviewee name</label>
    <input id="iname" value="{safe_n}" placeholder="Full name" />
  </div>
  <div class="field">
    <label>Job title</label>
    <input id="irole" value="{safe_r}" placeholder="e.g. Operations Manager" />
  </div>

  <button class="btn" id="create-btn" onclick="createSession()">
    Create Telegram session
  </button>

  <div class="result" id="result">
    <h3>Session created</h3>
    <p class="steps" id="steps"></p>
    <div class="cmd-row">
      <input class="cmd" id="cmd" readonly onclick="this.select()" />
      <button class="copy-btn" onclick="copyCmd()">Copy</button>
    </div>
  </div>
  <div class="error" id="err"></div>
</div>

<script>
async function createSession() {{
  var btn  = document.getElementById('create-btn');
  var name = document.getElementById('iname').value.trim();
  var role = document.getElementById('irole').value.trim();
  if (!name) {{ showErr('Please enter the interviewee name.'); return; }}

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating...';
  document.getElementById('err').style.display = 'none';

  try {{
    var res = await fetch('/create-session', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{
        campaign_id:      '{campaign_id}',
        interviewee_name: name,
        interviewee_role: role,
        guide:            {{}},
        config:           {{tone:'{tone}', depth:'{depth}', length:'{length}'}},
        mode:             'group'
      }})
    }});
    if (!res.ok) throw new Error('Server error ' + res.status);
    var data = await res.json();
    document.getElementById('steps').textContent = data.instructions;
    document.getElementById('cmd').value         = data.setup_command;
    document.getElementById('result').style.display = 'block';
    btn.style.display = 'none';
  }} catch(e) {{
    showErr('Failed to create session: ' + e.message);
    btn.disabled = false;
    btn.innerHTML = 'Create Telegram session';
  }}
}}

function copyCmd() {{
  var inp = document.getElementById('cmd');
  inp.select();
  document.execCommand('copy');
  var b = document.querySelector('.copy-btn');
  b.textContent = 'Copied!';
  setTimeout(function(){{ b.textContent = 'Copy'; }}, 2000);
}}

function showErr(msg) {{
  var el = document.getElementById('err');
  el.textContent = msg;
  el.style.display = 'block';
}}
</script>
</body>
</html>"""
    return HTMLResponse(html)
