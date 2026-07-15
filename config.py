import os

def _env(key, default=""):
    """Read an env var and strip whitespace/newlines that Railway sometimes
    adds when variables are pasted or set via the dashboard."""
    return os.environ.get(key, default).strip()

# ── Telegram ──────────────────────────────────────────────────────────────────
TELEGRAM_TOKEN = _env("TELEGRAM_TOKEN")
WEBHOOK_SECRET = _env("WEBHOOK_SECRET", "gaura-secret-2024")

# ── Claude ────────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = _env("ANTHROPIC_API_KEY")
CLAUDE_MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 400

# ── Speech-to-text (OpenAI Whisper) ──────────────────────────────────────────
OPENAI_API_KEY = _env("OPENAI_API_KEY")

# ── Twilio (phone call interviews) ────────────────────────────────────────────
TWILIO_ACCOUNT_SID   = _env("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN    = _env("TWILIO_AUTH_TOKEN")
TWILIO_PHONE_NUMBER  = _env("TWILIO_PHONE_NUMBER")

# ── Bland.ai (phone call interviews — replaces Twilio) ────────────────────────
BLAND_API_KEY = _env("BLAND_API_KEY")

# ── Interview mode ────────────────────────────────────────────────────────────
INTERVIEW_MODE = _env("INTERVIEW_MODE", "group")

# ── Storage backend ───────────────────────────────────────────────────────────
STORAGE_BACKEND = _env("STORAGE_BACKEND", "memory")
REDIS_URL = _env("REDIS_URL")

# ── Server ────────────────────────────────────────────────────────────────────
PORT = int(_env("PORT", "8000"))
BASE_URL = _env("BASE_URL")  # e.g. https://gaura-bot.up.railway.app
