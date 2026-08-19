# Put Tessa on Slack (5 minutes)

Tessa runs as a **Socket Mode** Slack app: the server dials out to Slack, so no
public URL, domain, or SSL is needed. She works from the same server as the
game — DM her an intake photo from any device and she drafts the Welcome
Letter + Notice to Insurance, uploads them into the thread for review, and
files the claim into Atlas PA, narrating every step. Nothing is emailed —
the documents stay right there in Slack. Meanwhile her in-game self
walks to the Market Stall and works on it, live.

## 1. Create the Slack app (one time)

1. Go to <https://api.slack.com/apps> and sign in to your workspace.
   (No workspace yet? Create one free at <https://slack.com/get-started>.)
2. **Create New App** → **From an app manifest** → pick your workspace.
3. Paste the contents of [`slack-app-manifest.json`](../slack-app-manifest.json)
   into the code box (the default **JSON** tab), replacing the sample that's
   already there → **Next** → **Create**.

## 2. Get the two tokens

**App-level token** (lets the server open the socket):

1. In the app's **Basic Information** page, scroll to **App-Level Tokens**.
2. **Generate Token and Scopes** → name it `socket` → **Add Scope** →
   `connections:write` → **Generate**.
3. Copy the token — it starts with `xapp-`.

**Bot token** (lets Tessa read files and post):

1. In the sidebar, **Install App** → **Install to Workspace** → **Allow**.
2. Copy the **Bot User OAuth Token** — it starts with `xoxb-`.

## 3. Give the tokens to the server

Local (`.env`):

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

Railway (production): project **hearty-balance** → service **agent-world** →
**Variables** → add both → redeploy. On boot the log should say:

```
Slack: Tessa is online via Socket Mode in "<your workspace>" — DM her an intake photo.
```

## 4. Use her

- Open Slack → **Apps** (bottom of the sidebar) → **Tessa** → send her an
  intake form as a photo (JPG/PNG/WebP/GIF, up to 5MB) or a PDF (up to
  10MB). That's it.
- **Dictation / recorded calls:** hit Slack's **mic button** (or upload
  m4a/mp3/wav, up to 24MB) — record the live call on speaker, repeating the
  homeowner's answers back, or dictate the finished form afterward. Whisper
  transcribes, the fields come off the conversation, and Tessa posts the
  filled **Intake Sheet** as a draft. **Nothing is filed until you approve:**
  say *approve* to file it into Atlas PA + ClaimWizard (letters + transcript
  included), tell her a correction ("phone should be …") to fix the sheet, or
  *cancel* to scrap it. Long call? Slack cuts clips at 5 minutes — just keep
  recording; she merges all clips into one intake. Needs `GROQ_API_KEY` in
  `.env` (free at console.groq.com/keys).
- In a channel: `/invite @Tessa`, then @mention her in a message that has the
  photo attached. She only reacts in channels when explicitly @mentioned.
- Text-only DMs get a short in-character reply (she'll steer you toward
  sending an intake photo).

She answers right in the chat (in channels she uses a thread under your
mention): what she read off the form (verify it!), the two drafted `.docx`
uploaded for review, and the Atlas PA claim number.

## Mira — the scheduling desk (second app, same recipe)

Mira books inspections on the firm's Outlook calendars from plain English.
She's a **separate Slack app** so the front desk really DMs "Mira":

1. Repeat step 1 with [`mira-slack-manifest.json`](../mira-slack-manifest.json).
2. Repeat step 2 (app-level token + install) and put the two tokens in `.env`
   as `MIRA_SLACK_BOT_TOKEN` / `MIRA_SLACK_APP_TOKEN`.
3. Map names to mailboxes in `.env`:
   `MIRA_PEOPLE=brielle=brielle@armadapa.com,andrew=andrew@armadapa.com`
   ("my calendar" resolves from the sender's Slack first name.)
4. The Outlook side reuses the existing `MS_*` variables (app-only Microsoft
   Graph with `Calendars.ReadWrite`) — no new Microsoft setup.

What she understands:

- *"Put an inspection on Andrew's and my calendar for Sept 5 at 10am, note:
  wind damage, bring ladder"* → one event on each mailbox, note in the body
- *"…it's unconfirmed but still put it on"* → booked **Tentative** with
  "(unconfirmed)" in the title; *"confirm the 10am on the 5th"* flips it solid
- *"Move the inspection on the 5th to the 9th"* / *"…to 2pm instead"*
- *"Cancel the 2pm inspection on the 9th"*
- *"What's on the calendar Friday?"* → reads everyone's day back

If a day has several matches she lists them and asks which one (answer with
the time: "the 10am one").

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Boot log: `Slack: failed to start — invalid_auth` | Wrong/expired `SLACK_BOT_TOKEN`. Re-copy from **Install App**. |
| Boot log: `failed to start` mentioning the app token | `SLACK_APP_TOKEN` wrong, or missing the `connections:write` scope. |
| She ignores channel messages | She only acts on @mentions in channels, and must be `/invite`d first. |
| `not_in_channel` errors | `/invite @Tessa` to that channel. |
| She says her "reading glasses are missing" | `ANTHROPIC_API_KEY` is unset on the server. |
| Changed scopes/events later | **Reinstall** the app (Install App → Reinstall) — scope changes need it. |
