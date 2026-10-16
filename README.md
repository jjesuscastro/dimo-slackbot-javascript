# Dimo PLEC Slack Bot

This bot watches messages in channels where it is invited. For attached HTML files and ZIP, RAR, or 7z archives containing HTML files it:

1. Checks the filename against the filename rules and its current concept list.
2. Replies with the filename problems and skips upload if validation fails.
3. Downloads a valid attachment from Slack, uploads it to PLEC, and replies with the returned preview link.

HTML and HTM files inside ZIP, RAR, and 7z archives are checked by filename and content, then uploaded with any directly attached HTML files. The content scan rejects `window.open` and its quoted bracket forms, and requires `mraid.open` in dot notation. It scans raw text, so matches in comments or strings count too. Other attachment types and non-HTML archive entries are ignored; an archive with no HTML or HTM entries is ignored. Archives are processed in memory, without creating temporary files. There is no configured archive-size, HTML file-count, or combined extracted-size limit; each HTML or HTM file is limited to 5 MB. All valid HTML files from one Slack message are sorted alphabetically by filename and uploaded together in a single PLEC request. Each iteration name is the filename without its `.html` or `.htm` extension. PLEC returns one preview link for the batch. If any filename or content check fails, the bot reports all issues and skips the entire batch. Replies are posted in the message thread. The File Renamer model and concept list are included under `file-renamer/` so the bot uses the same naming rules.

When a user edits a message containing HTML or an archive, the bot reprocesses the edited message's current attachments and replies in that message's thread. Responses to edits include the edit timestamp, localized to each Slack reader's timezone. Only files still attached to the edited message are checked.

## Run locally

Requires Node.js 20 or newer.

```powershell
cd E:\Dimo
npm install
Copy-Item .env.example .env
```

Fill in `.env`, then start the bot:

```powershell
npm start
```

The bot uses Slack Socket Mode, so it can run without a public HTTP endpoint. Keep the process running for it to receive Slack events.

## Deploy with Portainer

The repository includes a `Dockerfile` and `docker-compose.yml` for running the bot as a container. The Compose service builds the image from this repository (`pull_policy: build`), so a registry image is not required. To deploy it as a Portainer stack:

1. Push this project to a Git repository.
2. In Portainer, create a stack from that Git repository and set the Compose path to `docker-compose.yml`.
3. Add `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` as stack environment variables. Do not put real tokens in the repository.
4. Optionally set `ALLOWED_CHANNEL_IDS`, `PLEC_UPLOAD_URL`, or `PLEC_ORIGIN_URL` if needed, then deploy the stack.

Portainer builds the image from the repository. Do not enable a Portainer option that explicitly pulls the image before deployment; the image is built locally and is not published to a registry. The container restarts automatically unless it is stopped. To deploy updates, pull and redeploy the stack so Portainer rebuilds the image.

For local container deployment, set the same variables in a local `.env` file (copy `.env.example`) and run `docker compose up --build -d`.

## Slack app setup

Create a Slack app named **Dimo PLEC Slack Bot** for the workspace and configure:

- **Socket Mode:** enabled; create an app-level token with `connections:write` and set it as `SLACK_APP_TOKEN`.
- **Bot token scopes:** `chat:write`, `files:read`, and history scopes for the conversations you want it to watch (`channels:history`, `groups:history`, and/or `im:history`). Add the bot to the target channel.
- **Event subscriptions:** subscribe to the bot event `message.channels`; add `message.groups` or `message.im` if those conversation types are needed.
- Install or reinstall the app after changing scopes, then set the generated bot token as `SLACK_BOT_TOKEN`.

For a restricted rollout, set `ALLOWED_CHANNEL_IDS` to a comma-separated list of Slack channel IDs. If left empty, it handles attachments in any channel where it receives message events.

## PLEC configuration

`PLEC_UPLOAD_URL` and `PLEC_ORIGIN_URL` default to PLEC Upload Default settings:

- Upload endpoint: 
- Origin: 

Each iteration name is the full filename without the HTML extension, following PLEC Upload's **Use Filenames** behavior.

## Filename format

The filename must contain exactly these 11 underscore-separated parts:

```text
brand_acslanot_type_YYYYMMDD_version_creator_concept1_concept2_concept3_subconcept_theme.html
```

The fields are checked against File Renamer rules: lowercase letters/digits/hyphens for brand and creator, fixed `acslanot`, `mip` or `sip`, a real date, a positive version, a valid creator and valid concept/subconcept/theme choices. `.htm` is also accepted.

The PLEC Default endpoint appends a timestamp to the uploaded server-side filename.
