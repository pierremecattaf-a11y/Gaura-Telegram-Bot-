"""
Claude integration for the interview agent.
Builds the system prompt from the guide and conversation state,
calls Claude, detects interview completion, generates insight report.
"""

import json
import logging
import httpx
from config import ANTHROPIC_API_KEY, CLAUDE_MODEL, MAX_TOKENS

log = logging.getLogger(__name__)


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
        "summarise the 3-4 key themes you heard and say something like "
        "'That covers everything I wanted to explore — thank you so much for your time today.' "
        "Do NOT say the interview is over or finished. The admin will formally close the session.\n"
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

    # Advance after 3 user turns on the current question —
    # gives enough depth before moving on (was 2, too fast for short guides)
    user_turns = sum(1 for m in history[-8:] if m.get("role") == "user")
    return user_turns >= 3

# ── Call Claude ───────────────────────────────────────────────────────────────

async def get_next_message(session: dict) -> str:
    """Build the full message list and call Claude. Returns the reply text."""
    sys_prompt = build_system_prompt(session)
    history    = session.get("history") or []

    # Convert history to Claude message format.
    # Anthropic requires: non-empty content, and roles must alternate
    # (no two consecutive messages with the same role).
    messages = []
    for msg in history:
        role = "assistant" if msg.get("role") == "assistant" else "user"
        content = (msg.get("text") or "").strip()
        if not content:
            continue  # skip empty messages — Anthropic rejects these
        if messages and messages[-1]["role"] == role:
            # Merge consecutive same-role messages instead of sending
            # back-to-back duplicates, which Anthropic also rejects
            messages[-1]["content"] += "\n\n" + content
        else:
            messages.append({"role": role, "content": content})

    # Anthropic requires the conversation to start with a "user" message
    if messages and messages[0]["role"] != "user":
        messages = messages[1:]

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

        if resp.status_code != 200:
            log.error("Claude API error %d: %s", resp.status_code, resp.text[:300])

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

    user_turns = sum(1 for m in history if m.get("role") == "user")
    if user_turns == 0:
        return {
            "summary": "The interview ended before the interviewee provided any responses. "
                        "No insights could be generated.",
            "insights": [], "risks": [], "opportunities": [], "actions": [],
            "confidence": 0
        }

    prompt = (
        f"Interviewee: {name}" + (f", {role}" if role else "") + "\n"
        f"Campaign question: {question}\n\n"
        f"Transcript:\n{transcript}\n\n"
        "Generate a structured executive insight report. Be concise — "
        "this will be displayed in a UI card, not a long document.\n"
        "Limits: summary max 3 sentences. Max 4 insights, each detail max 2 sentences. "
        "Max 3 risks, max 3 opportunities (each one sentence). Max 4 actions.\n"
        "Return ONLY valid JSON, no markdown, no preamble:\n"
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
                "max_tokens": 3000,
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

        # Strip markdown code fences if present
        clean = raw.replace("```json", "").replace("```", "").strip()

        try:
            return json.loads(clean)
        except json.JSONDecodeError as e:
            # Claude sometimes adds preamble/trailing text around the JSON.
            # Try to extract just the {...} block.
            log.error("Report JSON parse failed: %s. Raw response: %s", e, raw[:500])
            start = clean.find("{")
            end   = clean.rfind("}")
            if start != -1 and end != -1 and end > start:
                try:
                    return json.loads(clean[start:end+1])
                except json.JSONDecodeError:
                    pass
            # Final fallback — return a minimal valid report rather than crashing
            return {
                "summary": "Report generation produced an unexpected format. "
                            "Raw transcript has been saved.",
                "insights": [], "risks": [], "opportunities": [], "actions": [],
                "confidence": 0,
                "_raw_response": raw[:1000],
            }
