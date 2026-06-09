import os

# ── Telegram ──────────────────────────────────────────────────────────────────
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "gaura-secret-2024")

# ── Claude ────────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = "claude-sonnet-4-20250514"
MAX_TOKENS = 400

# ── Interview mode ────────────────────────────────────────────────────────────
# "group"  — bot is in a group with you + interviewee; you can observe live
# "dm"     — bot DMs the interviewee directly; you see transcript after
INTERVIEW_MODE = os.environ.get("INTERVIEW_MODE", "group")

# ── Storage backend ───────────────────────────────────────────────────────────
# "memory" — dict in RAM (fine for testing, resets on restart)
# "redis"  — persistent (set REDIS_URL env var)
STORAGE_BACKEND = os.environ.get("STORAGE_BACKEND", "memory")
REDIS_URL = os.environ.get("REDIS_URL", "")

# ── Server ────────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("PORT", 8000))
BASE_URL = os.environ.get("BASE_URL", "")  # e.g. https://gaura-bot.up.railway.app
