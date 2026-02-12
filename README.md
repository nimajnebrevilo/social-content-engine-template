# Social Content Engine

An AI-powered content engine that mines your call transcripts for content ideas, interviews you about them via Slack, and drafts posts in your voice.

**What it does:**
1. Listens to your calls via [tldv](https://tldv.io) and pulls transcripts automatically
2. Uses Claude to extract content-worthy ideas from real conversations
3. Pings you on Slack (Mon/Wed/Fri) to interview you about the best ones
4. Drafts LinkedIn posts, newsletters, YouTube scripts, and X threads in your voice
5. Stores everything in Notion as your content pipeline

**Built with:** TypeScript, Claude API, Slack Socket Mode, Notion API, tldv API

---

## Quick Start (with Claude Code)

The fastest way to get this running is with [Claude Code](https://claude.ai/claude-code). Copy and paste the prompts below.

### Prerequisites

You'll need accounts on:
- [Anthropic](https://console.anthropic.com) (Claude API key)
- [Slack](https://slack.com) (a workspace where you're an admin)
- [Notion](https://notion.so) (free plan works)
- [tldv](https://tldv.io) (Business plan for API access — optional)
- [Railway](https://railway.com) (for hosting — $5/mo)

### Step 1: Clone and install

```
git clone https://github.com/YOUR_USERNAME/social-content-engine.git
cd social-content-engine
npm install
cp .env.example .env
```

### Step 2: Set up Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app **From scratch**.

**Bot Token Scopes** (OAuth & Permissions):
- `chat:write`
- `im:history`
- `im:read`
- `im:write`
- `users:read`

**Event Subscriptions** (enable, then subscribe to bot events):
- `message.im`

**Socket Mode**: Enable it and create an App-Level Token with `connections:write` scope.

**Install the app** to your workspace.

Then add to your `.env`:
```
SLACK_BOT_TOKEN=xoxb-...        # Bot User OAuth Token
SLACK_SIGNING_SECRET=...         # Basic Information > Signing Secret
SLACK_APP_TOKEN=xapp-...         # App-Level Token you just created
SLACK_USER_ID=U...               # Your Slack user ID
```

To find your Slack User ID: click your profile photo in Slack > Profile > ⋮ > Copy member ID.

### Step 3: Set up Notion

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations) and create a new integration
2. Copy the API key (starts with `secret_`)
3. Create a page in Notion where your databases will live
4. Share that page with your integration (click ⋮ > Connections > Add your integration)
5. Copy the page ID from the URL

Add to `.env`:
```
NOTION_API_KEY=secret_...
NOTION_PARENT_PAGE_ID=...        # The page ID from step 4
```

Then run the setup script:
```
npm run setup-notion
```

This creates two databases (Content Pipeline + Call Transcripts) and outputs their IDs. Add them to `.env`:
```
NOTION_CONTENT_DB_ID=...
NOTION_TRANSCRIPTS_DB_ID=...
```

### Step 4: Add remaining config

```
ANTHROPIC_API_KEY=sk-ant-...     # From console.anthropic.com
OWNER_NAME=Your Name             # Used in content drafts
TLDV_API_KEY=...                 # Optional — leave empty to skip tldv
```

### Step 5: Edit your voice profile

Open `voice-profile.md` and edit it to match how you write. The more specific, the better. Include:
- How you talk (casual? direct? technical?)
- Words or phrases you use
- Things you NEVER say
- Structural patterns you follow

### Step 6: Run locally

```
npm run dev
```

Open Slack, DM your bot, and type `help` to see commands.

### Step 7: Deploy to Railway

1. Push to GitHub
2. Go to [railway.com](https://railway.com), create a new project from your repo
3. Add all your `.env` variables in Railway's Variables tab
4. Railway auto-deploys on push to main

---

## Slack Commands

| Command | What it does |
|---------|-------------|
| `status` | Pipeline stats (transcripts, ideas, drafts) |
| `ideas` | List unprocessed content ideas |
| `mine` | Scan recent transcripts for new ideas |
| `1`, `2`, etc. | Start an interview for that idea number |
| `draft <id>` | Start an interview for a specific idea |
| `stop` | End the current interview |
| `help` | Show all commands |

## How the Interview Works

1. The agent pings you with an idea it found in your calls
2. It asks 3-5 follow-up questions to get enough material
3. Once it has enough, it drafts content in your voice
4. You get buttons: **Approve**, **Rework**, or **Syndicate to X**
5. Rework lets you give feedback and get a new version
6. Approved drafts are saved to Notion with status `approved`

## Architecture

```
tldv API  -->  Transcript Store  -->  Content Miner (Claude)
                                           |
                                     Content Ideas
                                           |
                                   Scheduler (cron)
                                           |
                                    Slack Interview
                                           |
                                   Draft Generator (Claude)
                                           |
                                      Notion DB
```

Single Node.js process. No database. Notion is the persistence layer. Claude API does all the thinking.

## Customisation

- **Voice profile**: Edit `voice-profile.md` or set `VOICE_PROFILE_PATH` env var
- **Schedule**: Change `CONTENT_PING_CRON` (default: Mon/Wed/Fri 9am)
- **Goals**: `LINKEDIN_POSTS_PER_WEEK`, `NEWSLETTER_PER_WEEK`
- **Formats**: LinkedIn posts, YouTube scripts, newsletters, X threads

## Cost Estimate

| Service | Cost |
|---------|------|
| Railway | ~$5/mo |
| Claude API | ~$5-15/mo (depends on usage) |
| tldv Business | ~$25/mo |
| Slack, Notion | Free |

---

## License

MIT
