# TikTok Workflow Desk — Live Browser Update

A mobile-friendly local Flask dashboard with a real embedded browser view, username queue, persistent browser profile, comment/message draft templates, configurable rotation, and activity history.

## What is implemented
- **Live browser view:** the dashboard displays screenshots from a real Playwright Chromium page and refreshes them while the browser view is open.
- **TikTok login:** start the browser and sign in on TikTok's own login page. The app does not ask you to enter your TikTok password into a dashboard form.
- **Persistent session:** Playwright uses a persistent local browser profile at `data/browser-profile`. Browser session data/cookies are saved by Chromium in that profile so the session may remain available on the next run. The app does not export or return raw cookies.
- **Browser interaction:** tap/click the live screen, send text to the focused browser field, and use basic keyboard controls. Text entered into the browser is not added to the dashboard logs or stored in `state.json`.
- **Username queue:** add profiles, open them in the embedded browser, and track status.
- **Template rotation:** comment and message drafts rotate after the configured number of selections (default 4 uses per template).
- **Activity tracking:** profile navigation and workspace changes are recorded locally.
- **Mobile layout:** responsive layout for phone screens.

## Important limits
This is a browser-assisted review tool, not a bulk-engagement bot. It does not automatically like videos, post comments, or send DMs. Review profiles and perform any engagement manually in TikTok, only where appropriate and allowed. Avoid unsolicited bulk messaging and repetitive spam. TikTok may display login challenges or restrict automated browsers; this tool does not bypass them.

## Deploy to Render
This repository includes a Docker-based Render setup. Render runs the Flask dashboard and Chromium on Linux; Termux is only needed to edit/push the project, not to run the remote browser.

1. Push this project to a Git repository and create a new Render Blueprint/Web Service from it.
2. Keep the included `render.yaml` and choose the `tiktok-workflow-desk` service.
3. When prompted, set `DASHBOARD_PASSWORD` to a strong, unique password. The default username is `admin`; you can change it with `DASHBOARD_USERNAME`.
4. Deploy. The Docker image includes Playwright's matching Chromium build and required Linux libraries. The persistent disk is mounted at `/var/data` for the queue and browser profile.
5. Open the Render service URL in your phone browser. The browser may take several seconds to start after the first request.

**Persistent storage and cost:** the Blueprint requests a 1 GB persistent disk and a paid `starter` service plan. Render persistent disks are not available on free web services. Do not remove the disk if you need the saved TikTok browser profile to persist between deploys. Keep the dashboard password private; it protects the browser-control endpoints and logged-in session.

The service deliberately runs one Gunicorn worker and one thread because Playwright's synchronous browser object must stay on a single thread. The `/healthz` endpoint is unauthenticated for Render health checks; other dashboard and browser endpoints require the configured Basic Auth credentials.

## Run locally
Python 3.10+ and a desktop Linux/macOS/Windows environment that Playwright Chromium supports. Native Android/Termux generally does not support Playwright's bundled desktop Chromium; for this deployment, the browser runs on Render instead.

```sh
pip install -r requirements.txt
python -m playwright install chromium
python app.py
```
Open `http://127.0.0.1:5000` locally.

## Install and run
```sh
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
python app.py
```
Open `http://127.0.0.1:5000` on the same computer. On a phone, use the computer's LAN address only on a trusted private network; if doing so, configure the host deliberately and never expose this dashboard to the public internet.

## Data and session privacy
- Queue, templates, and activity: `data/state.json`
- Persistent browser session/profile: `${DATA_DIR}/browser-profile/` (Render uses `/var/data/browser-profile/`)
- Keep the `data/` directory private. Do not upload it, share it, or commit it to a repository. Delete `data/browser-profile/` only if you want to sign out/remove the locally stored browser session.
- Do not share session files or cookies. Anyone who gains access to a logged-in browser profile may be able to access that session.

## Existing state
The app creates `data/state.json` on first run. Back up the file before replacing project code if you want to preserve your existing queue and templates.


## Updated browser workflow
- The embedded browser opens Google first. Navigate/search for TikTok manually and sign in there.
- The persistent browser profile is stored in `DATA_DIR/browser-profile` (default `data/browser-profile`). Treat this directory as sensitive; never commit or share it. Session persistence depends on the host having persistent disk storage.
- The dashboard has independent preference toggles for likes, comments, and DMs plus delay/limit values. These are review preferences only; the app does not perform unattended bulk engagement.
- This is an embedded Chromium view, not a launch of the phone's installed Chrome app. The browser runs on the host where Flask/Playwright runs.


## Assisted engagement actions

The browser panel includes user-triggered, one-at-a-time assisted actions:
- **Like current post** clicks a clearly identified Like control on the currently open TikTok post, after a confirmation prompt.
- **Prepare comment** inserts text into an identifiable comment composer; you must review and submit it yourself.
- **Prepare direct message** inserts text into an identifiable message composer; you must review and send it yourself.

Enable each action separately in the dashboard before using it. The backend enforces a short minimum interval and a maximum of 25 assisted actions per running application process. There is no unattended queue runner or bulk engagement loop. TikTok's interface can change, so a control may not be detected on every page; the tool reports that instead of guessing. Keep the browser profile private and use the dashboard only on a trusted local network.


### Bounded current-page actions

The browser action controls run one action on the currently open TikTok post or conversation when you tap the matching button; there is no second confirmation prompt. Likes act on the current post. Comments and direct messages are submitted only when the browser detects a clear, enabled, action-specific Post or Send button. The server enforces a minimum five-second interval and a maximum of 25 actions per application process. This is not a queue-wide or background bulk sender. TikTok may change its interface, so check the visible browser state and use interactions only where appropriate.
