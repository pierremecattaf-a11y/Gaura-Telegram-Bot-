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
