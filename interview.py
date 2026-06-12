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
    guide    = session.get("guide") or {}
    config   = session.get("config") or {}
    q_index  = session.get("question_index", 0)
    history  = session.get("history") or []
    name     = session.get("interviewee_name") or "the interviewee"
    role     = session.get("interviewee_role") or ""
    question = guide.get("objective") or guide.get("q") or "the campaign question"
    tone     = config.get("tone") or "Conversational"
    depth    = config.get("depth") or "Deep"

    questions = guide.get("questions") or []
    followups = guide.get("followups") or []
    total_q   = len(questions)
    ai_turns  = sum(1 for m in history if m.get("role") == "assistant")
    nearing_end = q_index >= total_q - 1 if total_q > 0 else False

    # Build guide checklist
    guide_block = ""
    if questions:
        guide_block += "\n\nINTERVIEW GUIDE — FOLLOW THIS EXACTLY:\n"
        if guide.get("objective"):
            guide_block += "Objective: " + guide["objective"] + "\n"
        guide_block += "\nQUESTIONS (work through ALL in order — never skip):\n"
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
            guide_block += "\nFOLLOW-UP AREAS (probe deeper on any question):\n"
            for f in followups:
                guide_block += f"- {f}\n"
    else:
        # No guide — use general investigative approach
        guide_block = (
            "\n\nNo specific guide provided. Use the 5 Whys method to investigate the "
            "campaign question. Cover at least 4 distinct topics, probing root causes, "
            "specific examples, what has been tried, and what would help."
        )

    nearing_str = (
        "\n⚠️ You are on the LAST question. After their answer, "
        "summarise the 3-4 key themes you heard and close warmly.\n"
        if nearing_end else ""
    )

    progress = (
        f"Progress: {total_q} questions total, ~{ai_turns} turns completed, "
        f"currently on question {q_index + 1} of {total_q}."
        if total_q > 0
        else f"Progress: {ai_turns} turns completed so far."
    )

    return (
        f"You are Gaura, an AI interviewer conducting a structured interview on Telegram.\n"
        f"Interviewee: {name}" + (f", {role}" if role else "") + ".\n"
        f"Campaign question: {question}\n"
        f"Tone: {tone}. Depth: {depth}.\n"
        f"{guide_block}\n\n"
        f"STRICT RULES:\n"
        f"1. NEVER skip a guide question. Work through them in order.\n"
        f"2. For each question: ask it naturally, then probe with 1-2 WHY follow-ups "
        f"(5 Whys method), then move to the next.\n"
        f"3. After probing each topic, propose ONE hypothesis solution and ask for a "
        f"reaction — e.g. 'One approach we are considering is X — what is your view?' "
        f"This validates whether solutions make sense from their perspective.\n"
        f"4. Push for specifics: 'Can you give me a concrete example?' or "
        f"'What caused that to happen?'\n"
        f"5. {progress}\n"
        f"{nearing_str}"
        f"\nFORMAT: This is Telegram. Keep each message to 2-4 sentences maximum. "
        f"Natural conversational language only — no bullet points, no headers, no markdown bold."
    )


# ── Question advancement ──────────────────────────────────────────────────────

def should_advance_question(session: dict, user_reply: str) -> bool:
    """
    Advance the question index after ~2 user replies per question.
    Claude's prompt handles the actual conversational logic.
    """
    history   = session.get("history") or []
    q_index   = session.get("question_index", 0)
    questions = (session.get("guide") or {}).get("questions") or []

    if not questions or q_index >= len(questions) - 1:
        return False

    # Count user turns since last advance — rough heuristic
    user_turns = sum(1 for m in history[-6:] if m.get("role") == "user")
    return user_turns >= 2


def is_interview_complete(session: dict) -> bool:
    """
    Interview is complete when Claude has sent a closing message.
    """
    history   = session.get("history") or []
    questions = (session.get("guide") or {}).get("questions") or []
    q_index   = session.get("question_index", 0)

    # Need at least a few turns
    if len(history) < 4:
        return False

    # If there's a guide, must be on or past the last question
    if questions and q_index < len(questions) - 1:
        return False

    # Check if Claude's last message contains closing language
    last_ai = next(
        (m.get("text", "") for m in reversed(history) if m.get("role") == "assistant"),
        ""
    )
    closing_signals = [
        "thank you", "thanks for", "that's been", "that has been",
        "really helpful", "we've covered", "we have covered",
        "to summarise", "to summarize", "key themes", "wrap up",
        "been very helpful", "appreciate your time"
    ]
    return any(sig in last_ai.lower() for sig in closing_signals)


# ── Call Claude ───────────────────────────────────────────────────────────────

async def get_next_message(session: dict) -> str:
    """Build the full message list and call Claude. Returns the reply text."""
    sys_prompt = build_system_prompt(session)
    history    = session.get("history") or []

    # Convert history to Claude message format
    messages = []
    for msg in history:
        role = "assistant" if msg.get("role") == "assistant" else "user"
        content = msg.get("text", "")
        if content:
            messages.append({"role": role, "content": content})

    if not messages:
        # First turn — prime Claude to open the interview
        name = session.get("interviewee_name") or "there"
        messages = [{
            "role": "user",
            "content": (
                f"Begin the interview now. Greet {name} warmly by name, "
                f"explain in one short sentence what you will be exploring together, "
                f"and immediately ask the first question. "
                f"Keep it to 3 sentences maximum — this is a Telegram chat."
            )
        }]

    async with httpx.AsyncClient(timeout=45.0) as client:
        import logging
        log = logging.getLogger(__name__)
        log.info("=== CLAUDE REQUEST DEBUG ===")
        log.info("sys_prompt length: %d", len(sys_prompt))
        log.info("sys_prompt first 300 chars: %r", sys_prompt[:300])
        log.info("sys_prompt last 300 chars: %r", sys_prompt[-300:])
        log.info("messages: %r", messages)
        log.info("model: %r", CLAUDE_MODEL)

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

        log.info("=== CLAUDE RESPONSE DEBUG ===")
        log.info("status_code: %d", resp.status_code)
        log.info("response body first 500 chars: %r", resp.text[:500])

        resp.raise_for_status()
        data = resp.json()

        # Extract text from response
        content_blocks = data.get("content") or []
        text = "".join(
            block.get("text", "")
            for block in content_blocks
            if block.get("type") == "text"
        )
        return text.strip() or "Could you tell me more about that?"


# ── Generate insight report ───────────────────────────────────────────────────

async def generate_insight_report(session: dict) -> dict:
    """Generate a structured insight report from the interview transcript."""
    history  = session.get("history") or []
    name     = session.get("interviewee_name") or "the interviewee"
    role     = session.get("interviewee_role") or ""
    guide    = session.get("guide") or {}
    question = guide.get("objective") or "the campaign question"

    transcript = "\n\n".join(
        f"{'Gaura' if m.get('role') == 'assistant' else name}: {m.get('text','')}"
        for m in history
        if m.get("text")
    )

    if not transcript:
        return {
            "summary": "No transcript available.",
            "insights": [], "risks": [], "opportunities": [], "actions": [],
            "confidence": 0
        }

    prompt = (
        f"Interviewee: {name}" + (f", {role}" if role else "") + "\n"
        f"Campaign question: {question}\n\n"
        f"Transcript:\n{transcript}\n\n"
        "Generate a structured executive insight report. "
        "Return ONLY valid JSON:\n"
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
        data  = resp.json()
        raw   = "".join(
            b.get("text", "") for b in (data.get("content") or [])
            if b.get("type") == "text"
        )
        clean = raw.replace("```json", "").replace("```", "").strip()
        return json.loads(clean)
