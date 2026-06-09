"""
Storage layer for interview sessions.
Swap STORAGE_BACKEND=redis to persist across restarts.
Session key = campaign_id + "_" + interviewee slug.
"""

import json
import time
from config import STORAGE_BACKEND, REDIS_URL

# ── In-memory store (default) ─────────────────────────────────────────────────
_store = {}

def _redis_client():
    import redis
    return redis.from_url(REDIS_URL, decode_responses=True)

# ── Public API ────────────────────────────────────────────────────────────────

def save_session(session_id: str, data: dict):
    data["updated_at"] = time.time()
    if STORAGE_BACKEND == "redis":
        r = _redis_client()
        r.set("session:" + session_id, json.dumps(data), ex=86400 * 7)  # 7 days
    else:
        _store[session_id] = data


def load_session(session_id: str) -> dict | None:
    if STORAGE_BACKEND == "redis":
        r = _redis_client()
        raw = r.get("session:" + session_id)
        return json.loads(raw) if raw else None
    return _store.get(session_id)


def delete_session(session_id: str):
    if STORAGE_BACKEND == "redis":
        r = _redis_client()
        r.delete("session:" + session_id)
    else:
        _store.pop(session_id, None)


def list_sessions() -> list[str]:
    if STORAGE_BACKEND == "redis":
        r = _redis_client()
        keys = r.keys("session:*")
        return [k.replace("session:", "") for k in keys]
    return list(_store.keys())


# ── Session factory ───────────────────────────────────────────────────────────

def new_session(
    campaign_id: str,
    interviewee_name: str,
    interviewee_role: str,
    guide: dict,
    config: dict,
    mode: str = "group",
) -> dict:
    """Create a fresh session dict. Save it yourself after calling this."""
    slug = interviewee_name.lower().replace(" ", "-")
    session_id = campaign_id + "_" + slug + "_" + str(int(time.time()))[-6:]
    return {
        "session_id": session_id,
        "campaign_id": campaign_id,
        "interviewee_name": interviewee_name,
        "interviewee_role": interviewee_role,
        "guide": guide,
        "config": config,
        "history": [],           # list of {role, text}
        "question_index": 0,     # which guide question we're on
        "status": "pending",     # pending → active → complete
        "mode": mode,            # "group" or "dm"
        "group_chat_id": None,   # set when /start is received in the group
        "interviewee_user_id": None,  # set when interviewee is confirmed
        "admin_user_id": None,   # the campaign owner (you)
        "created_at": time.time(),
        "updated_at": time.time(),
    }
