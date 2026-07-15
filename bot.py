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
import base64
import httpx
import logging
from urllib.parse import unquote
from fastapi import FastAPI, Request, HTTPException, Response
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware

import config
import storage
import interview

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="Gaura Telegram Bot")

# ── CORS ──────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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


# ── Voice transcription ───────────────────────────────────────────────────────

async def transcribe_voice(file_id: str) -> tuple[str | None, str | None]:
    """
    Download a Telegram voice/audio file and transcribe it using OpenAI Whisper.
    Returns (transcript, error_reason). On success: (text, None).
    On failure: (None, reason) where reason is a short user-facing string.
    """
    if not config.OPENAI_API_KEY:
        return None, "not_configured"

    try:
        # Step 1: get the file path from Telegram
        file_info = await tg("getFile", file_id=file_id)
        file_path = file_info.get("result", {}).get("file_path")
        if not file_path:
            log.error("Could not get file_path for file_id %s", file_id)
            return None, "download_failed"

        # Step 2: download the audio bytes
        download_url = f"https://api.telegram.org/file/bot{config.TELEGRAM_TOKEN}/{file_path}"
        async with httpx.AsyncClient(timeout=30.0) as client:
            audio_resp = await client.get(download_url)
            audio_resp.raise_for_status()
            audio_bytes = audio_resp.content

        # Step 3: send to OpenAI Whisper
        # Telegram voice notes are .oga (ogg/opus) — Whisper accepts them natively
        filename = file_path.split("/")[-1]
        if "." not in filename:
            filename += ".oga"

        async with httpx.AsyncClient(timeout=60.0) as client:
            whisper_resp = await client.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {config.OPENAI_API_KEY}"},
                files={"file": (filename, audio_bytes, "audio/ogg")},
                data={"model": "whisper-1", "response_format": "text"},
            )

            if whisper_resp.status_code == 429:
                body = whisper_resp.text.lower()
                if "insufficient_quota" in body or "quota" in body:
                    log.error("Whisper quota exceeded: %s", whisper_resp.text[:200])
                    return None, "quota_exceeded"
                log.error("Whisper rate limited: %s", whisper_resp.text[:200])
                return None, "rate_limited"

            if whisper_resp.status_code == 401:
                log.error("Whisper auth failed: %s", whisper_resp.text[:200])
                return None, "invalid_key"

            whisper_resp.raise_for_status()
            transcript = whisper_resp.text.strip()
            log.info("Transcribed voice note: %s...", transcript[:80])
            return transcript, None

    except Exception as e:
        log.error("Transcription failed: %s", e)
        return None, "unknown_error"


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

    # Deactivate any previous session bound to this group chat.
    # Without this, find_session_for_group would still match the old
    # session (status=active) and the new one would never be used.
    for old_sid in storage.list_sessions():
        if old_sid == session_id:
            continue
        old_sess = storage.load_session(old_sid)
        if old_sess and old_sess.get("group_chat_id") == chat_id and old_sess.get("status") in ("pending", "active"):
            old_sess["status"] = "superseded"
            storage.save_session(old_sid, old_sess)
            log.info("Superseded old session %s for chat %s", old_sid, chat_id)

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
    /start — begins the interview.
    If sent by the admin: opens the interview without touching interviewee_user_id.
    If sent by a non-admin: registers them as the interviewee and opens.
    """
    sid, sess = find_session_for_group(chat_id)
    if not sess:
        await send(chat_id, "No active session found for this group. Ask the admin to run `/setup` first.")
        return

    # Only register as interviewee if the sender is NOT the admin.
    # This allows the admin to fire /start to open the interview,
    # while keeping the interviewee slot free for the real person.
    if user_id != sess.get("admin_user_id"):
        sess["interviewee_user_id"] = user_id
        log.info("Interviewee registered: user=%s session=%s", user_id, sid)
    else:
        log.info("Admin started interview without overwriting interviewee slot: session=%s", sid)

    sess["status"] = "active"
    storage.save_session(sid, sess)

    await send_typing(chat_id)

    try:
        reply = await interview.get_next_message(sess)
        log.info("Opening message generated, length=%d", len(reply))
    except Exception as e:
        log.error("Failed to get opening message: %s", e)
        await send(chat_id, "⚠️ Could not start the interview. Error: " + str(e))
        return

    if not reply:
        await send(chat_id, "⚠️ Got an empty response from Claude. Please check your ANTHROPIC_API_KEY.")
        return

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


async def handle_reset(chat_id: int, user_id: int):
    """
    /reset — admin command. Marks all sessions for this group as superseded,
    so a fresh /setup starts clean. Useful during testing.
    """
    count = 0
    for sid in storage.list_sessions():
        sess = storage.load_session(sid)
        if sess and sess.get("group_chat_id") == chat_id:
            sess["status"] = "superseded"
            storage.save_session(sid, sess)
            count += 1
    await send(chat_id, f"_Reset: {count} session(s) for this group marked inactive. Run /setup with a new session ID._")


async def handle_status(chat_id: int):
    """
    /status — show current session state.
    """
    sid, sess = find_session_for_group(chat_id)
    if not sess:
        await send(chat_id, "No active session in this group.")
        return
    questions = (sess.get("guide") or {}).get("questions") or []
    q_index   = sess.get("question_index", 0)
    turns     = len(sess.get("history") or [])
    await send(
        chat_id,
        f"*Session:* `{sid}`\n"
        f"*Status:* {sess.get('status')}\n"
        f"*Interviewee:* {sess.get('interviewee_name')}\n"
        f"*Progress:* Q{q_index + 1} of {len(questions)}\n"
        f"*Turns:* {turns}"
    )


async def handle_check(chat_id: int):
    """
    /check — verify all API keys and config are working.
    Run this before starting an interview to catch problems early.
    """
    lines = []

    # Check Telegram token
    me = await tg("getMe")
    if me.get("ok"):
        lines.append("✅ Telegram token valid — bot: @" + me["result"].get("username","?"))
    else:
        lines.append("❌ Telegram token invalid or missing")

    # Check Anthropic API key
    if not config.ANTHROPIC_API_KEY:
        lines.append("❌ ANTHROPIC_API_KEY is not set in Railway Variables")
    else:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": config.ANTHROPIC_API_KEY,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": config.CLAUDE_MODEL,
                        "max_tokens": 10,
                        "messages": [{"role": "user", "content": "Hi"}],
                    },
                )
            if resp.status_code == 200:
                lines.append("✅ Anthropic API key valid")
            elif resp.status_code == 401:
                lines.append("❌ Anthropic API key is invalid (401 Unauthorized)")
            elif resp.status_code == 404:
                lines.append("❌ Anthropic API key missing or wrong (404) — check ANTHROPIC_API_KEY in Railway Variables")
            else:
                lines.append(f"⚠️ Anthropic API returned {resp.status_code}")
        except Exception as e:
            lines.append(f"❌ Anthropic API error: {e}")

    # Check OpenAI key (optional)
    if config.OPENAI_API_KEY:
        lines.append("✅ OpenAI API key set (voice transcription enabled)")
    else:
        lines.append("ℹ️ OPENAI_API_KEY not set — voice notes will not be transcribed")

    # Check storage
    try:
        storage.save_session("__test__", {"test": True})
        storage.delete_session("__test__")
        lines.append("✅ Storage working")
    except Exception as e:
        lines.append(f"❌ Storage error: {e}")

    await send(chat_id, "*System check*\n\n" + "\n".join(lines))


# ── Core reply logic ──────────────────────────────────────────────────────────

async def handle_reply(chat_id: int, user_id: int, text: str, message_id: int):
    """Process an interviewee reply and generate the next question."""
    sid, sess = find_session_for_group(chat_id)
    if not sess:
        log.warning("handle_reply: no active session for chat %s", chat_id)
        return

    # Accept messages from the confirmed interviewee OR the admin
    # (admin can type on behalf of the interviewee in facilitated sessions)
    is_admin       = user_id == sess.get("admin_user_id")
    is_interviewee = user_id == sess.get("interviewee_user_id")

    # If interviewee slot is empty and this is not the admin,
    # auto-register them — handles cases where the real interviewee
    # writes without sending /start first, or where admin started
    # the interview and the interviewee slot was never set.
    if not is_admin and not is_interviewee and not sess.get("interviewee_user_id"):
        sess["interviewee_user_id"] = user_id
        storage.save_session(sid, sess)
        is_interviewee = True
        log.info("Auto-registered interviewee: user=%s session=%s", user_id, sid)

    if not is_admin and not is_interviewee:
        return

    # Ignore if paused
    if sess.get("status") == "paused":
        return

    # Add user reply to history
    sess["history"].append({"role": "user", "text": text})

    # Advance question index if enough replies given on current question
    if interview.should_advance_question(sess, text):
        questions = (sess.get("guide") or {}).get("questions") or []
        if questions:
            sess["question_index"] = min(
                sess.get("question_index", 0) + 1,
                len(questions) - 1
            )

    storage.save_session(sid, sess)
    await send_typing(chat_id)

    try:
        reply = await interview.get_next_message(sess)
        log.info("Reply generated for session %s, length=%d", sid, len(reply))
    except Exception as e:
        log.error("Failed to generate reply: %s", e)
        await send(chat_id, "Error generating response: " + str(e))
        return

    if not reply:
        await send(chat_id, "Got an empty response — please try sending your answer again.")
        return

    sess["history"].append({"role": "assistant", "text": reply})
    storage.save_session(sid, sess)
    await send(chat_id, reply)


async def generate_and_store_report(sid: str, sess: dict) -> dict | None:
    """
    Generate the insight report for any session (Telegram or phone),
    store it, and return it. Returns None on failure.
    Channel-agnostic — can be called from finish_interview, call status
    webhook, or the REST endpoint below.
    """
    try:
        report = await interview.generate_insight_report(sess)
        sess["report"] = report
        sess["status"] = "complete"
        storage.save_session(sid, sess)
        log.info("Report generated and stored for session %s", sid)
        return report
    except Exception as e:
        log.error("Report generation failed for session %s: %s", sid, e)
        return None


async def finish_interview(sid: str, sess: dict, chat_id: int, early: bool = False):
    """End a Telegram interview, generate report, post summary to group."""
    sess["status"] = "complete"
    storage.save_session(sid, sess)

    await send(chat_id, "_Interview ended. Generating insight report..._")
    await send_typing(chat_id)

    report = await generate_and_store_report(sid, sess)

    if not report:
        await send(chat_id, "Report generation failed. Transcript has been saved — you can generate the report manually in Gaura.")
        return

    summary           = report.get("summary", "")
    insights          = report.get("insights", [])
    actions           = report.get("actions", [])
    confidence        = report.get("confidence", "")
    confidence_reason = report.get("confidence_reason", "")

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
    if confidence_reason:
        report_text += f"\n_{confidence_reason}_"

    await send(chat_id, report_text)
    await send(chat_id,
        f"_Full report saved. Session ID: `{sid}`_\n"
        f"_Open Gaura to view the complete insights._"
    )


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

    log.info("Webhook message: chat=%s user=%s type=%s",
             chat_id, user_id, "voice" if (message.get("voice") or message.get("audio")) else "text")

    # ── Handle voice notes and audio messages ────────────────────────────────
    voice = message.get("voice") or message.get("audio")
    if voice and not text:
        file_id  = voice.get("file_id")
        duration = voice.get("duration", 0)
        log.info("Voice note received: file_id=%s duration=%ss", file_id, duration)

        # Let the user know we're processing
        await send_typing(chat_id)
        await send(chat_id, "_🎙 Voice note received — transcribing..._")

        transcript, error = await transcribe_voice(file_id)

        if error:
            error_messages = {
                "not_configured": (
                    "⚠️ Voice notes require an OpenAI API key for transcription.\n"
                    "Add `OPENAI_API_KEY` to your Railway environment variables, "
                    "or type your answer as text."
                ),
                "invalid_key": (
                    "⚠️ OpenAI API key is invalid. Check `OPENAI_API_KEY` in Railway "
                    "Variables, or type your answer as text."
                ),
                "quota_exceeded": (
                    "⚠️ OpenAI account has no available quota for transcription.\n"
                    "Add a payment method at platform.openai.com → Settings → Billing, "
                    "or type your answer as text."
                ),
                "rate_limited": (
                    "⚠️ Transcription is rate-limited right now. "
                    "Please wait a moment and try again, or type your answer."
                ),
                "download_failed": (
                    "⚠️ Could not download the voice note from Telegram. "
                    "Please try again or type your answer."
                ),
                "unknown_error": (
                    "⚠️ Could not transcribe the voice note. "
                    "Please try again or type your answer."
                ),
            }
            await send(chat_id, error_messages.get(error, error_messages["unknown_error"]))
            return JSONResponse({"ok": True})

        # Show the transcript so the user can confirm what was heard
        await send(chat_id, f'_Transcript: "{transcript}"_')

        # Route as a normal reply
        await handle_reply(chat_id, user_id, transcript, message_id)
        return JSONResponse({"ok": True})

    # ── Ignore messages with no text and no voice ────────────────────────────
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
        elif command == "/check":  await handle_check(chat_id)
        elif command == "/reset":  await handle_reset(chat_id, user_id)
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
        interviewee_phone  = body.get("interviewee_phone", ""),
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
        "session_id":       session_id,
        "interviewee_name": sess.get("interviewee_name"),
        "status":           sess.get("status"),
        "report":           report,
        "transcript":       sess.get("history", []),
    })


@app.post("/session/{session_id}/generate-report")
async def trigger_report(session_id: str):
    """
    Generate (or regenerate) the insight report for any session,
    regardless of channel. Called automatically after a phone call ends,
    or manually from the Gaura web app.
    """
    sess = storage.load_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    report = await generate_and_store_report(session_id, sess)
    if not report:
        raise HTTPException(status_code=500, detail="Report generation failed")

    return JSONResponse({
        "session_id": session_id,
        "report":     report,
    })


@app.get("/report-embed/{session_id}", response_class=HTMLResponse)
async def report_embed(session_id: str):
    """
    Tiny page meant to be loaded in a hidden iframe from Gaura.
    Loads the report for this session and posts it to the parent window
    via postMessage — this works even when the parent page (a Claude
    artifact) has its outgoing fetch() calls blocked by CSP, because
    postMessage and iframe loading are not subject to that restriction.
    """
    sess = storage.load_session(session_id)

    if not sess:
        payload = json.dumps({"ok": False, "error": "session_not_found", "session_id": session_id})
    else:
        report = sess.get("report")
        if not report:
            payload = json.dumps({
                "ok": False,
                "error": "not_ready",
                "session_id": session_id,
                "status": sess.get("status"),
            })
        else:
            payload = json.dumps({
                "ok": True,
                "session_id": session_id,
                "interviewee_name": sess.get("interviewee_name"),
                "status": sess.get("status"),
                "report": report,
                "transcript": sess.get("history", []),
            })

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body>
<script>
  var payload = {payload};
  // Post to parent window (Gaura artifact). "*" target is fine here —
  // the payload contains only this session's own interview data.
  if (window.parent) {{
    window.parent.postMessage({{ source: "gaura-telegram-report", data: payload }}, "*");
  }}
</script>
</body>
</html>"""
    return HTMLResponse(html)


# ── Health check ──────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "mode": config.INTERVIEW_MODE}


@app.get("/debug")
async def debug():
    """Shows whether config is loaded correctly, without exposing secrets."""
    return {
        "claude_model":          config.CLAUDE_MODEL,
        "anthropic_key_set":     bool(config.ANTHROPIC_API_KEY),
        "telegram_token_set":    bool(config.TELEGRAM_TOKEN),
        "telegram_token_length": len(config.TELEGRAM_TOKEN),
        "base_url":              config.BASE_URL or "NOT SET",
        "interview_mode":        config.INTERVIEW_MODE,
        "storage_backend":       config.STORAGE_BACKEND,
        "openai_key_set":        bool(config.OPENAI_API_KEY),
        "twilio_configured":     bool(config.TWILIO_ACCOUNT_SID),
        "twilio_phone":          config.TWILIO_PHONE_NUMBER or "NOT SET",
        "call_inbound_url":      (config.BASE_URL or "") + "/call/inbound",
        "call_status_url":       (config.BASE_URL or "") + "/call/status",
    }


# ── Claude proxy endpoints (used by the Gaura web app) ───────────────────────
# Browsers cannot call api.anthropic.com directly due to CORS.
# These endpoints sit on Railway (same-origin as the API key) and proxy
# Claude requests on behalf of the web app — the API key never touches
# the browser.

@app.post("/proxy/chat")
async def proxy_chat(request: Request):
    """
    Proxy a standard Claude chat request.
    Body: { model, max_tokens, system, messages }
    """
    if not config.ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured on server")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    # Only allow fields Claude actually needs — strip anything else
    payload = {
        "model":      body.get("model", config.CLAUDE_MODEL),
        "max_tokens": int(body.get("max_tokens", 1000)),
        "messages":   body["messages"],
    }
    if body.get("system"):
        payload["system"] = body["system"]

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key":         config.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type":      "application/json",
            },
            json=payload,
        )
    return JSONResponse(content=resp.json(), status_code=resp.status_code)


@app.post("/proxy/search")
async def proxy_search(request: Request):
    """
    Proxy a Claude request that includes the web_search tool.
    Body: { model, max_tokens, system, messages }
    """
    if not config.ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY not configured on server")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    payload = {
        "model":      body.get("model", config.CLAUDE_MODEL),
        "max_tokens": int(body.get("max_tokens", 2000)),
        "messages":   body["messages"],
        "tools":      [{"type": "web_search_20250305", "name": "web_search"}],
    }
    if body.get("system"):
        payload["system"] = body["system"]

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key":         config.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type":      "application/json",
            },
            json=payload,
        )
    return JSONResponse(content=resp.json(), status_code=resp.status_code)


# -- Bland.ai phone call endpoints -------------------------------------------
#
# Bland.ai handles the full voice loop (STT + LLM + TTS).
# We send one API call to start the interview, and receive a webhook
# when it ends with the full transcript.


async def call_bland(phone: str, task: str, webhook_url: str,
                     max_duration: int = 45) -> dict:
    """Send an outbound call via Bland.ai."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.bland.ai/v1/calls",
            headers={
                "authorization": config.BLAND_API_KEY,
                "Content-Type":  "application/json",
            },
            json={
                "phone_number":      phone,
                "task":              task,
                "voice":             "maya",
                "language":          "en",
                "max_duration":      max_duration,
                "webhook":           webhook_url,
                "wait_for_greeting": True,
                "record":            True,
                "reduce_latency":    True,
            },
        )
        resp.raise_for_status()
        return resp.json()


@app.post("/call/start")
async def call_start(request: Request):
    """
    Gaura web app calls this when the user clicks the Call button.
    Body: { session_id }
    Looks up the session, builds the prompt, and dials via Bland.
    """
    if not config.BLAND_API_KEY:
        raise HTTPException(status_code=503, detail="BLAND_API_KEY not configured")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    session_id = body.get("session_id", "")
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id required")

    sess = storage.load_session(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")

    phone = sess.get("interviewee_phone", "")
    if not phone:
        raise HTTPException(status_code=400,
                            detail="No phone number registered for this session")

    sys_prompt = interview.build_system_prompt(sess)
    task = (
        sys_prompt + "\n\n"
        "VOICE CALL RULES:\n"
        "- Keep each response to 2-3 sentences maximum.\n"
        "- Speak naturally. No bullet points, no lists, no markdown.\n"
        "- Wait for the person to finish before responding.\n"
        "- When all guide questions are covered, thank them warmly and end the call."
    )

    webhook_url = config.BASE_URL.rstrip("/") + "/call/webhook"

    try:
        result = await call_bland(phone, task, webhook_url)
        call_id = result.get("call_id", "")
        log.info("Bland call started: call_id=%s session=%s phone=%s",
                 call_id, session_id, phone)

        sess["call_sid"] = call_id
        sess["status"]   = "active"
        sess["channel"]  = "phone"
        storage.save_session(session_id, sess)

        return JSONResponse({
            "ok":         True,
            "call_id":    call_id,
            "session_id": session_id,
            "message":    "Call initiated to " + phone,
        })

    except httpx.HTTPStatusError as e:
        log.error("Bland error: %s %s", e.response.status_code, e.response.text[:200])
        raise HTTPException(status_code=502,
                            detail="Bland API error: " + e.response.text[:200])
    except Exception as e:
        log.error("Call start failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/call/webhook")
async def call_webhook(request: Request):
    """
    Bland.ai POSTs here when a call ends with the full transcript.
    We store it and auto-generate the insight report.
    """
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    call_id    = body.get("call_id", "")
    status     = body.get("status", "")
    transcript = body.get("transcripts") or []
    concat     = body.get("concatenated_transcript", "")
    duration   = body.get("call_length", 0)

    log.info("Bland webhook: call_id=%s status=%s duration=%ss turns=%d",
             call_id, status, duration, len(transcript))

    # Find session by call_id
    sid, sess = None, None
    for s in storage.list_sessions():
        candidate = storage.load_session(s)
        if candidate and candidate.get("call_sid") == call_id:
            sid, sess = s, candidate
            break

    if not sess:
        log.warning("No session for Bland call_id %s", call_id)
        return JSONResponse({"ok": True})

    # Convert Bland transcript to our history format
    history = []
    for turn in transcript:
        role = turn.get("role", "")
        text = (turn.get("text") or "").strip()
        if not text:
            continue
        if role in ("assistant", "agent"):
            history.append({"role": "assistant", "text": text})
        elif role in ("user", "human"):
            history.append({"role": "user", "text": text})

    # Fallback: parse concatenated_transcript string
    if not history and concat:
        for line in concat.split("\n"):
            line = line.strip()
            low = line.lower()
            if low.startswith("assistant:"):
                history.append({"role": "assistant", "text": line[10:].strip()})
            elif low.startswith("user:"):
                history.append({"role": "user", "text": line[5:].strip()})

    sess["history"]       = history
    sess["status"]        = "complete"
    sess["call_duration"] = duration
    storage.save_session(sid, sess)

    user_turns = sum(1 for m in history if m.get("role") == "user")
    if user_turns == 0:
        log.info("Call %s had no user responses — skipping report", call_id)
        return JSONResponse({"ok": True})

    log.info("Generating report for phone session %s (%d user turns)", sid, user_turns)
    await generate_and_store_report(sid, sess)
    return JSONResponse({"ok": True})



# ── Register webhook (run once) ───────────────────────────────────────────────

@app.on_event("startup")
async def startup_checks():
    """Validate required environment variables on startup and log clearly."""
    missing = []
    if not config.TELEGRAM_TOKEN:
        missing.append("TELEGRAM_TOKEN")
    if not config.ANTHROPIC_API_KEY:
        missing.append("ANTHROPIC_API_KEY")
    if not config.BASE_URL:
        missing.append("BASE_URL (webhook will not be registered)")

    if missing:
        log.warning("=" * 60)
        log.warning("MISSING ENVIRONMENT VARIABLES: %s", ", ".join(missing))
        log.warning("Set these in Railway → Variables, then redeploy.")
        log.warning("=" * 60)
    else:
        log.info("All required environment variables are set.")

    if config.TWILIO_ACCOUNT_SID:
        log.info("Twilio configured — phone number: %s", config.TWILIO_PHONE_NUMBER or "NOT SET")
        log.info("Configure Twilio webhook URLs in your Twilio console:")
        log.info("  Inbound call:  POST %s/call/inbound", config.BASE_URL)
        log.info("  Call status:   POST %s/call/status", config.BASE_URL)
    else:
        log.info("Twilio not configured — phone call interviews disabled")

    # Register webhook
    if config.BASE_URL and config.TELEGRAM_TOKEN:
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

@app.get("/create", response_class=HTMLResponse)
async def create_page(
    campaign_id: str = "",
    name: str = "",
    role: str = "",
    tone: str = "Conversational",
    depth: str = "Deep",
    length: str = "standard",
    guide_b64: str = "",
):
    name   = unquote(name)
    role   = unquote(role)
    safe_n = name.replace("'", "\'")
    safe_r = role.replace("'", "\'")

    # Decode guide from base64 if provided
    guide_json = "{}"
    if guide_b64:
        try:
            guide_json = base64.b64decode(guide_b64.encode()).decode("utf-8")
        except Exception:
            guide_json = "{}"

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
    .sub {{ font-size:13px; color:#6B7280; margin-bottom:24px; line-height:1.5; }}
    .meta {{ background:#F9FAFB; border:1px solid #E5E7EB; border-radius:8px;
             padding:12px 14px; margin-bottom:20px; font-size:12px; color:#374151; line-height:1.7; }}
    .meta strong {{ color:#111827; }}
    .q-count {{ display:inline-block; background:#EFF6FF; color:#2563EB;
                padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; }}
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
  <p class="sub">This will register a Telegram interview session and give you the setup command.</p>

  <div class="meta">
    <strong>Interviewee:</strong> {safe_n}<br>
    <strong>Role:</strong> {safe_r or "—"}<br>
    <strong>Guide:</strong> <span class="q-count" id="q-count">loading...</span>
  </div>

  <button class="btn" id="create-btn" onclick="createSession()">
    Create Telegram session
  </button>

  <div class="result" id="result">
    <h3>✅ Session created</h3>
    <p class="steps" id="steps"></p>
    <div class="cmd-row">
      <input class="cmd" id="cmd" readonly onclick="this.select()" />
      <button class="copy-btn" onclick="copyCmd()">Copy</button>
    </div>
  </div>
  <div class="error" id="err"></div>
</div>

<script>
var GUIDE = {guide_json};
var qCount = (GUIDE && GUIDE.questions) ? GUIDE.questions.length : 0;
document.getElementById('q-count').textContent = qCount + ' question' + (qCount !== 1 ? 's' : '');

async function createSession() {{
  var btn = document.getElementById('create-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating...';
  document.getElementById('err').style.display = 'none';

  try {{
    var res = await fetch('/create-session', {{
      method: 'POST',
      headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{
        campaign_id:      '{campaign_id}',
        interviewee_name: '{safe_n}',
        interviewee_role: '{safe_r}',
        guide:            GUIDE,
        config:           {{tone:'{tone}', depth:'{depth}', length:'{length}'}},
        mode:             'group'
      }})
    }});
    if (!res.ok) {{
      var txt = await res.text();
      throw new Error('Server error ' + res.status + ': ' + txt.slice(0,200));
    }}
    var data = await res.json();
    document.getElementById('steps').textContent = data.instructions;
    document.getElementById('cmd').value         = data.setup_command;
    document.getElementById('result').style.display = 'block';
    btn.style.display = 'none';
  }} catch(e) {{
    showErr('Failed: ' + e.message);
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
