# Put Tessa on Slack (5 minutes)

Tessa runs as a **Socket Mode** Slack app: the server dials out to Slack, so no
public URL, domain, or SSL is needed. She works from the same server as the
game — DM her an intake photo from any device and she drafts the Welcome
Letter + Notice to Insurance, emails them to the firm, and files the claim
into Atlas PA, narrating every step in the thread. Meanwhile her in-game self
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

- Open Slack → **Apps** (bottom of the sidebar) → **Tessa** → send her a
  photo (JPG/PNG/WebP/GIF, up to 5MB) of an intake form. That's it.
- In a channel: `/invite @Tessa`, then @mention her in a message that has the
  photo attached. She only reacts in channels when explicitly @mentioned.
- Text-only DMs get a short in-character reply (she'll steer you toward
  sending an intake photo).

She answers in a thread on your message: what she read off the form (verify
it!), the two drafted `.docx` uploaded for review, the email confirmation, and
the Atlas PA claim number.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Boot log: `Slack: failed to start — invalid_auth` | Wrong/expired `SLACK_BOT_TOKEN`. Re-copy from **Install App**. |
| Boot log: `failed to start` mentioning the app token | `SLACK_APP_TOKEN` wrong, or missing the `connections:write` scope. |
| She ignores channel messages | She only acts on @mentions in channels, and must be `/invite`d first. |
| `not_in_channel` errors | `/invite @Tessa` to that channel. |
| She says her "reading glasses are missing" | `ANTHROPIC_API_KEY` is unset on the server. |
| Docs drafted but "didn't email them" | `RESEND_API_KEY` unset, or the From domain isn't verified in Resend. |
| Changed scopes/events later | **Reinstall** the app (Install App → Reinstall) — scope changes need it. |
