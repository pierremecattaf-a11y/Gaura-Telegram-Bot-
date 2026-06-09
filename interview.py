"""
Claude integration for the interview agent.
Builds the system prompt from the guide and conversation state,
calls Claude, detects interview completion, generates insight report.
"""

import json
import httpx
from config import ANTHROPIC_API_KEY, CLAUDE_MODEL, MAX_TOKENS


# ── System prompt ─────────────────────────────────────────────────────────────

def build_system_prompt(session: dict) -> str:
    guide    = session.get("guide", {})
    config   = session.get("config", {})
    q_index  = session.get("question_index", 0)
    history  = session.get("history", [])
    name     = session.get("interviewee_name", "the interviewee")
    role     = session.get("interviewee_role", "")
    question = guide.get("objective", "")
    tone     = config.get("tone", "Conversational")
    depth    = config.get("depth", "Deep")

    questions  = guide.get("questions", [])
    followups  = guide.get("followups", [])
    total_q    = len(questions)
    ai_turns   = sum(1 for m in history if m["role"] == "assistant")
    nearing_end = q_index >= total_q - 1

    # Build guide checklist with [DONE] / [CURRENT] / [PENDING] labels
    guide_block = ""
    if questions:
        guide_block += "\n\nINTERVIEW GUIDE — FOLLOW THIS EXACTLY:\n"
        if guide.get("objective"):
            guide_block += "Objective: " + guide["objective"] + "\n"
        guide_block += "\nQUESTIONS (work through ALL of them in order — never skip):\n"
        for i, q in enumerate(questions):
            if i < q_index:
                status = "[DONE]"
            elif i == q_index:
                status = "[CURRENT]"
            else:
                status = "[PENDING]"
            guide_block += f"{i+1}. {status} {q}\n"

        remaining = questions[q_index:]
        if remaining:
            guide_block += f"\nSTILL TO COVER ({len(remaining)} question(s)):\n"
            for q in remaining:
                guide_block += f"- {q}\n"

        if followups:
            guide_block += "\nFOLLOW-UP AREAS (use these to probe deeper):\n"
            for f in followups:
                guide_block += f"- {f}\n"

    nearing_str = (
        "\n⚠️ You are on the LAST question. After their answer, "
        "summarise the 3-4 key themes you heard and close warmly.\n"
        if nearing_end else ""
    )

    return (
        f"You are Gaura, an AI interviewer on Telegram.\n"
        f"Interviewee: {name}, {role}.\n"
        f"Campaign question: {question}\n"
        f"Tone: {tone}. Depth: {depth}.\n"
        f"{guide_block}\n\n"
        f"STRICT RULES:\n"
        f"1. NEVER skip a guide question. Work through them in order.\n"
        f"2. For each question: ask it naturally, then probe with 1-2 WHY follow-ups "
        f"(5 Whys method), then move to the next.\n"
        f"3. After probing each topic, briefly propose ONE hypothesis solution and ask "
        f"for a reaction — e.g. 'One approach we are considering is X — what is your "
        f"view on that?' This tests whether solutions make sense from their experience.\n"
        f"4. Push for specifics: 'Can you give me a concrete example?' or "
        f"'What caused that to happen?'\n"
        f"5. Progress: {total_q} questions total, approximately {ai_turns} turns so far, "
        f"currently on question {q_index + 1}.\n"
        f"{nearing_str}"
        f"\nFORMAT: You are on Telegram. Keep each message to 2-4 sentences maximum. "
        f"Natural conversational language only — no bullet points, no headers, no markdown."
    )


# ── Detect if guide question has been answered ────────────────────────────────

def should_advance_question(session: dict, user_reply: str) -> bool:
    """
    Heuristic: advance the question index after every 2 user replies per question.
    This is a simple pacing mechanism. Claude's prompt handles the actual logic.
    """
    history = session.get("history", [])
    q_index = session.get("question_index", 0)
    questions = session.get("guide", {}).get("questions", [])

    if q_index >= len(questions) - 1:
        return False  # already on last question

    # Count user turns since we last advanced
    user_turns_on_current = 0
    for msg in reversed(history):
        if msg["role"] == "user":
            user_turns_on_current += 1
        if user_turns_on_current >= 2:
            return True
    return False


def is_interview_complete(session: dict) -> bool:
    """Interview is complete when we've reached the last question and
    the interviewee has replied at least once to it."""
    questions = session.get("guide", {}).get("questions", [])
    q_index   = session.get("question_index", 0)
    history   = session.get("history", [])

    if not questions:
        # No guide — use turn count
        return len([m for m in history if m["role"] == "user"]) >= 8

    on_last = q_index >= len(questions) - 1
    user_replied_to_last = any(
        m["role"] == "user"
        for m in history[-(len(history) // 2):]
    )
    # Also check if Claude has sent a closing message
    last_ai = next(
        (m["text"] for m in reversed(history) if m["role"] == "assistant"),
        ""
    )
    closing_signals = [
        "thank you", "thanks for", "that's been", "that has been",
        "really helpful", "we've covered", "we have covered",
        "to summarise", "to summarize", "key themes"
    ]
    ai_closed = any(sig in last_ai.lower() for sig in closing_signals)

    return on_last and user_replied_to_last and ai_closed


# ── Call Claude ───────────────────────────────────────────────────────────────

async def get_next_message(session: dict) -> str:
    """Build the full message list and call Claude. Returns the reply text."""
    sys_prompt = build_system_prompt(session)
    history    = session.get("history", [])

    # Convert history to Claude message format
    messages = []
    for msg in history:
        role = "assistant" if msg["role"] == "assistant" else "user"
        messages.append({"role": role, "content": msg["text"]})

    if not messages:
        # First turn — prime the bot to open the interview
        name = session.get("interviewee_name", "there")
        messages = [{
            "role": "user",
            "content": (
                f"Begin the interview. Greet {name} warmly, "
                f"briefly explain the purpose in one sentence, "
                f"and ask the first question from the guide. "
                f"Keep it concise — this is Telegram."
            )
        }]

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": CLAUDE_MODEL,
                "max_tokens": MAX_TOKENS,
                "system": sys_prompt,
                "messages": messages,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return "".join(
            block.get("text", "")
            for block in data.get("content", [])
            if block.get("type") == "text"
        )


# ── Generate insight report ───────────────────────────────────────────────────

async def generate_insight_report(session: dict) -> dict:
    """Call Claude to generate a structured insight report from the transcript."""
    history  = session.get("history", [])
    name     = session.get("interviewee_name", "the interviewee")
    role     = session.get("interviewee_role", "")
    guide    = session.get("guide", {})
    question = guide.get("objective", "the campaign question")

    transcript = "\n\n".join(
        f"{'Gaura' if m['role'] == 'assistant' else name}: {m['text']}"
        for m in history
    )

    prompt = (
        f"Interviewee: {name}, {role}\n"
        f"Campaign question: {question}\n\n"
        f"Transcript:\n{transcript}\n\n"
        "Generate a structured executive insight report. "
        "Return ONLY valid JSON with this structure:\n"
        '{"summary":"...","insights":[{"title":"...","detail":"..."}],'
        '"risks":["..."],"opportunities":["..."],'
        '"actions":[{"action":"...","owner":"...","timeline":"..."}],'
        '"confidence":87}'
    )

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": CLAUDE_MODEL,
                "max_tokens": 1500,
                "system": "Generate executive interview insight reports. Return only valid JSON, no markdown.",
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        resp.raise_for_status()
        data   = resp.json()
        raw    = "".join(
            b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
        )
        clean  = raw.replace("```json", "").replace("```", "").strip()
        return json.loads(clean)
