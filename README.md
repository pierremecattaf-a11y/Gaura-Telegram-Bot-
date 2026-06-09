# Gaura Telegram Bot

AI-powered interview agent for Telegram. Conducts structured interviews
following the guide you built in the Gaura platform.

---

## Setup in 4 steps

### Step 1 — Create your Telegram bot (5 minutes)

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a name: e.g. `Gaura Interview Bot`
4. Choose a username: e.g. `GauraInterviewBot` (must end in `bot`)
5. Copy the **token** BotFather gives you — you'll need it next

---

### Step 2 — Deploy to Railway (10 minutes)

1. Push this folder to a GitHub repository
2. Go to [railway.app](https://railway.app) and sign in with GitHub
3. Click **New Project → Deploy from GitHub repo**
4. Select your repo
5. Railway will detect the `Procfile` and deploy automatically
6. Go to **Settings → Environment Variables** and add:

```
TELEGRAM_TOKEN      = <token from BotFather>
ANTHROPIC_API_KEY   = <your Anthropic API key>
BASE_URL            = <your Railway app URL, e.g. https://gaura-bot.up.railway.app>
WEBHOOK_SECRET      = <any random string, e.g. gaura-secret-abc123>
INTERVIEW_MODE      = group
STORAGE_BACKEND     = memory
```

7. Redeploy after setting env vars
8. Visit `https://your-app.up.railway.app/health` — you should see `{"status":"ok"}`

---

### Step 3 — Run your first interview

**From the Gaura platform:**

1. Open a campaign, go to the Interviews tab
2. Configure the interview for your interviewee
3. Click **Send via Telegram**
4. Copy the `session_id` shown

**In Telegram:**

1. Create a group: you + the bot + the interviewee
2. Send: `/setup <session_id>`
3. The bot confirms the session and shows the guide details
4. Ask the interviewee to send `/start`
5. The interview begins automatically

**During the interview:**

| Command | Who | What it does |
|---------|-----|--------------|
| `/status` | Admin | Shows session progress |
| `/pause` | Admin | Pauses the interview |
| `/resume` | Admin | Resumes after pause |
| `/skip` | Admin | Skips to the next guide question |
| `/end` | Admin | Ends interview + generates report |

---

### Step 4 — Get the insight report

When the interview finishes (naturally or via `/end`), the bot posts a
summary in the group. The full report is available via:

```
GET https://your-app.up.railway.app/session/<session_id>/report
```

Or open Gaura — if the platform is connected to the same storage,
the Insights panel will update automatically.

---

## Switching to DM mode

Change one env var:

```
INTERVIEW_MODE=dm
```

In DM mode the bot skips the group setup and interviews the person
directly in a private conversation. Everything else stays the same.

---

## Switching to Redis (production)

1. Add a Redis service in Railway (one click)
2. Set:
```
STORAGE_BACKEND=redis
REDIS_URL=<Redis connection URL from Railway>
```

Sessions now persist across restarts.

---

## API reference

### POST /create-session
Called by Gaura when the user clicks "Send via Telegram".

```json
{
  "campaign_id": "1234567890",
  "interviewee_name": "Sarah Ahmed",
  "interviewee_role": "Regional Operations Manager",
  "guide": {
    "objective": "Understand the root causes of...",
    "questions": ["Q1...", "Q2..."],
    "followups": ["Escalation history", "..."]
  },
  "config": {
    "tone": "Conversational",
    "depth": "Deep",
    "length": "standard"
  }
}
```

Returns:
```json
{
  "session_id": "1234567890_sarah-ahmed_abc123",
  "bot_link": "https://t.me/GauraInterviewBot",
  "setup_command": "/setup 1234567890_sarah-ahmed_abc123",
  "instructions": "1. Add @GauraInterviewBot to your group..."
}
```

### GET /session/{session_id}/report
Returns the completed insight report and full transcript.
