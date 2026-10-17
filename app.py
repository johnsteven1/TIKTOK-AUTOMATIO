from flask import Flask, request, jsonify, render_template
from pathlib import Path
from datetime import datetime, timezone
import json, os, re, threading, base64, time, hmac
from io import BytesIO

BASE = Path(__file__).resolve().parent
DATA = Path(os.environ.get("DATA_DIR", BASE / "data"))
DATA.mkdir(parents=True, exist_ok=True)
DB = DATA / "state.json"
LOCK = threading.Lock()
BROWSER_LOCK = threading.RLock()
_browser = {"playwright": None, "context": None, "page": None, "started": False, "error": "", "last_url": ""}
BROWSER_PROFILE = DATA / "browser-profile"
_ACTION_GUARD = {"count": 0, "last_at": 0.0}

DEFAULT = {
    "profiles": [],
    "comments": [
        "I enjoyed this video — thanks for sharing!",
        "This was interesting. Keep creating!",
        "Really nice content!",
        "Thanks for sharing this with us."
    ],
    "messages": [
        "Hi! I came across your profile and enjoyed your content.",
        "Hello! I liked your recent video — hope you’re having a good day.",
        "Hey! Your content caught my attention. Keep it up!"
    ],
    "logs": [],
    "comment_usage": 0,
    "message_usage": 0,
    "settings": {"rotation_every": 4}
}

def load_state():
    if not DB.exists():
        save_state(DEFAULT)
        return json.loads(json.dumps(DEFAULT))
    try:
        state = json.loads(DB.read_text(encoding="utf-8"))
        for key, value in DEFAULT.items():
            state.setdefault(key, value)
        return state
    except (ValueError, OSError):
        save_state(DEFAULT)
        return json.loads(json.dumps(DEFAULT))

def save_state(state):
    tmp = DB.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(DB)

def now():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")

def log_event(state, username, action, status, detail=""):
    state["logs"].insert(0, {
        "time": now(), "username": username, "action": action,
        "status": status, "detail": detail
    })
    state["logs"] = state["logs"][:500]

app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024

# Set DASHBOARD_PASSWORD on Render. HTTP Basic Auth protects the dashboard,
# browser-control endpoints, screenshots, and static assets from public access.
DASHBOARD_USERNAME = os.environ.get("DASHBOARD_USERNAME", "admin")
DASHBOARD_PASSWORD = os.environ.get("DASHBOARD_PASSWORD", "").strip()

@app.before_request
def protect_public_dashboard():
    if request.path == "/healthz" or not DASHBOARD_PASSWORD:
        return None
    auth = request.authorization
    supplied_user = auth.username if auth and auth.username else ""
    supplied_password = auth.password if auth and auth.password else ""
    user_ok = hmac.compare_digest(supplied_user, DASHBOARD_USERNAME)
    password_ok = hmac.compare_digest(supplied_password, DASHBOARD_PASSWORD)
    if not (user_ok and password_ok):
        return ("Dashboard authentication required.", 401,
                {"WWW-Authenticate": 'Basic realm="TikTok Workflow Desk", charset="UTF-8"',
                 "Cache-Control": "no-store"})
    return None

@app.get("/healthz")
def health_check():
    return jsonify(ok=True)


def browser_status():
    with BROWSER_LOCK:
        page = _browser.get("page")
        return {"running": bool(page and not page.is_closed()),
                "url": ((page.url.split("?", 1)[0]) if page and not page.is_closed() else (_browser.get("last_url", "").split("?", 1)[0])),
                "title": (page.title() if page and not page.is_closed() else ""),
                "error": _browser.get("error", ""),
                "session_note": "Sign-in is kept in the local browser profile; raw cookies are never exposed by the API."}


def ensure_browser():
    with BROWSER_LOCK:
        page = _browser.get("page")
        if page and not page.is_closed():
            return page
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise RuntimeError("Browser support is not installed. Run: pip install -r requirements.txt, then install Chromium with: python -m playwright install chromium") from exc
        try:
            if _browser.get("playwright") is None:
                _browser["playwright"] = sync_playwright().start()
            BROWSER_PROFILE.mkdir(parents=True, exist_ok=True)
            context = _browser["playwright"].chromium.launch_persistent_context(
                user_data_dir=str(BROWSER_PROFILE), headless=True,
                viewport={"width": 390, "height": 844}, device_scale_factor=1,
                args=["--disable-dev-shm-usage", "--no-sandbox"])
            context.set_default_timeout(10000)
            page = context.pages[0] if context.pages else context.new_page()
            _browser["context"] = context
            _browser["page"] = page
            _browser["started"] = True
            _browser["error"] = ""
            if not page.url or page.url == "about:blank":
                page.goto("https://www.google.com/", wait_until="domcontentloaded", timeout=15000)
            _browser["last_url"] = page.url
            return page
        except Exception as exc:
            _browser["error"] = str(exc)[:300]
            raise RuntimeError("Could not start the browser: " + str(exc)[:220]) from exc


@app.get("/api/browser/status")
def api_browser_status():
    return jsonify(browser_status())


@app.post("/api/browser/start")
def api_browser_start():
    try:
        page = ensure_browser()
        with BROWSER_LOCK:
            _browser["last_url"] = page.url
        return jsonify(ok=True, status=browser_status())
    except Exception as exc:
        return jsonify(error=str(exc)), 503


@app.post("/api/browser/navigate")
def api_browser_navigate():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip().lstrip("@")
    if username and not re.fullmatch(r"[A-Za-z0-9._]{2,24}", username):
        return jsonify(error="Enter a valid TikTok username, or leave blank to open Google for manual navigation."), 400
    try:
        with BROWSER_LOCK:
            page = ensure_browser()
            target_url = f"https://www.tiktok.com/@{username}" if username else "https://www.google.com/"
            page.goto(target_url, wait_until="domcontentloaded", timeout=15000)
            _browser["last_url"] = page.url
        with LOCK:
            state = load_state()
            log_event(state, username or "—", "Open profile" if username else "Open browser", "Opened", "Page opened for manual review.")
            save_state(state)
        return jsonify(ok=True, status=browser_status())
    except Exception as exc:
        return jsonify(error=str(exc)[:300]), 503


@app.get("/api/browser/screenshot")
def api_browser_screenshot():
    try:
        with BROWSER_LOCK:
            page = _browser.get("page")
            if not page or page.is_closed():
                return jsonify(error="Browser is not running."), 409
            image = page.screenshot(type="jpeg", quality=65, full_page=False)
            url = page.url
            title = page.title()
            _browser["last_url"] = url
        return app.response_class(image, mimetype="image/jpeg", headers={"Cache-Control": "no-store", "X-Browser-Url": url[:500], "X-Browser-Title": title[:200]})
    except Exception as exc:
        return jsonify(error=str(exc)[:250]), 503


@app.post("/api/browser/click")
def api_browser_click():
    payload = request.get_json(silent=True) or {}
    try:
        x, y = int(payload.get("x", -1)), int(payload.get("y", -1))
    except (TypeError, ValueError):
        return jsonify(error="Invalid click coordinates."), 400
    if not (0 <= x <= 1200 and 0 <= y <= 2000):
        return jsonify(error="Click coordinates are outside the allowed range."), 400
    try:
        with BROWSER_LOCK:
            page = ensure_browser()
            page.mouse.click(x, y)
            _browser["last_url"] = page.url
        return jsonify(ok=True)
    except Exception as exc:
        return jsonify(error=str(exc)[:250]), 503


@app.post("/api/browser/type")
def api_browser_type():
    payload = request.get_json(silent=True) or {}
    value = payload.get("text", "")
    if not isinstance(value, str) or len(value) > 2000:
        return jsonify(error="Text must be at most 2000 characters."), 400
    try:
        with BROWSER_LOCK:
            page = ensure_browser()
            # Text is sent straight to the current browser focus and is not logged or persisted by this app.
            page.keyboard.insert_text(value)
        return jsonify(ok=True)
    except Exception as exc:
        return jsonify(error=str(exc)[:250]), 503


@app.post("/api/browser/key")
def api_browser_key():
    payload = request.get_json(silent=True) or {}
    key = str(payload.get("key", ""))
    if key not in {"Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"}:
        return jsonify(error="Key is not allowed."), 400
    try:
        with BROWSER_LOCK:
            page = ensure_browser()
            page.keyboard.press(" " if key == "Space" else key)
            _browser["last_url"] = page.url
        return jsonify(ok=True)
    except Exception as exc:
        return jsonify(error=str(exc)[:250]), 503


@app.post("/api/browser/stop")
def api_browser_stop():
    with BROWSER_LOCK:
        try:
            context = _browser.get("context")
            if context:
                context.close()
        except Exception:
            pass
        _browser.update({"context": None, "page": None, "started": False})
    return jsonify(ok=True, status=browser_status())



@app.post("/api/browser/action")
def api_browser_action():
    """Run one bounded action on the currently open TikTok post or conversation. No background/bulk loop."""
    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action", "")).strip().lower()
    text_value = payload.get("text", "")
    if action not in {"like", "comment", "message"}:
        return jsonify(error="Choose like, comment, or message."), 400
    if action in {"comment", "message"} and (
        not isinstance(text_value, str) or not text_value.strip() or len(text_value) > 1000
    ):
        return jsonify(error="Enter text (maximum 1000 characters) before preparing this action."), 400
    with BROWSER_LOCK:
        now_ts = time.monotonic()
        if now_ts - _ACTION_GUARD["last_at"] < 5:
            return jsonify(error="Action rate limit: wait at least 5 seconds between interactions."), 429
        if _ACTION_GUARD["count"] >= 25:
            return jsonify(error="Session action limit reached (25). Restart the application to reset the safety limit."), 429
        try:
            page = ensure_browser()
            if "tiktok.com" not in (page.url or "").lower():
                return jsonify(error="Navigate to TikTok and open the intended post/profile first."), 409
            result = ""
            if action == "like":
                # Only click an explicit Like control. Never click if the page already indicates it is liked.
                liked = page.get_by_role("button", name=re.compile(r"^(liked|unlike)$", re.I))
                if liked.count():
                    return jsonify(ok=True, action=action, status="Already liked", detail="No change made; the current post appears already liked.")
                like_button = page.get_by_role("button", name=re.compile(r"^like$", re.I))
                if not like_button.count():
                    like_button = page.locator('button[aria-label="Like"], [data-e2e="like-icon"]')
                if not like_button.count():
                    return jsonify(error="Could not find a clear Like button on this page. Open a single video and try again."), 422
                like_button.first.click(timeout=5000)
                result = "Clicked Like on the currently open post."
            else:
                # Only use action-specific composers; never fall back to an arbitrary editable field.
                candidates = [
                    page.locator('[contenteditable="true"][data-e2e="comment-input"]'),
                    page.locator('[contenteditable="true"][data-e2e*="comment"]'),
                    page.locator('textarea[placeholder*="comment" i]'),
                    page.locator('[contenteditable="true"][aria-label*="comment" i]'),
                ] if action == "comment" else [
                    page.locator('[contenteditable="true"][data-e2e*="message"]'),
                    page.locator('textarea[placeholder*="message" i]'),
                    page.locator('[contenteditable="true"][aria-label*="message" i]'),
                ]
                composer = None
                for candidate in candidates:
                    try:
                        if candidate.count() and candidate.first.is_visible():
                            composer = candidate.first
                            break
                    except Exception:
                        continue
                if composer is None:
                    return jsonify(error=("Could not identify the comment field. Open a video with comments enabled first." if action == "comment" else "Could not identify a message composer. Open the intended conversation first.")), 422
                composer.click(timeout=3000)
                try:
                    composer.fill(text_value.strip(), timeout=3000)
                except Exception:
                    page.keyboard.insert_text(text_value.strip())
                # Submit only the explicitly requested action, and only when a clear enabled
                # action-specific button is present on the currently open page.
                if action == "comment":
                    submit_candidates = [
                        page.get_by_role("button", name=re.compile(r"^post$", re.I)),
                        page.locator('button[data-e2e*="comment-post"]'),
                    ]
                else:
                    submit_candidates = [
                        page.get_by_role("button", name=re.compile(r"^send$", re.I)),
                        page.locator('button[data-e2e*="send"]'),
                    ]
                submit = None
                for candidate in submit_candidates:
                    try:
                        if candidate.count() and candidate.first.is_visible() and candidate.first.is_enabled():
                            submit = candidate.first
                            break
                    except Exception:
                        continue
                if submit is None:
                    return jsonify(error=("Comment text was entered, but no clear enabled Post button was found. Nothing was submitted." if action == "comment" else "Message text was entered, but no clear enabled Send button was found. Nothing was submitted.")), 422
                submit.click(timeout=5000)
                result = "Comment submitted on the currently open post." if action == "comment" else "Message submitted in the currently open conversation."
            _ACTION_GUARD["count"] += 1
            _ACTION_GUARD["last_at"] = time.monotonic()
            _browser["last_url"] = page.url
            with LOCK:
                state = load_state()
                log_event(state, "current page", action.title(), "Submitted" if action in {"comment", "message"} else "Clicked",
                          result)
                save_state(state)
            return jsonify(ok=True, action=action, status="Submitted" if action in {"comment", "message"} else "Clicked",
                           detail=result, action_count=_ACTION_GUARD["count"], action_limit=25)
        except Exception:
            # Avoid returning page content, browser internals, or credentials in error messages.
            return jsonify(error="The browser action could not be completed. Check the current page and try again."), 503


@app.get("/")
def index():
    return render_template("index.html")

@app.get("/api/state")
def api_state():
    with LOCK:
        s = load_state()
        return jsonify(s)

@app.post("/api/profiles")
def add_profiles():
    payload = request.get_json(silent=True) or {}
    raw = payload.get("usernames", "")
    if not isinstance(raw, str):
        return jsonify(error="usernames must be text"), 400
    names = []
    for line in raw.splitlines():
        name = line.strip().lstrip("@")
        if not name:
            continue
        if not re.fullmatch(r"[A-Za-z0-9._]{2,24}", name):
            return jsonify(error=f"Invalid username: {line.strip()}"), 400
        names.append(name)
    if not names:
        return jsonify(error="Enter at least one valid username."), 400
    with LOCK:
        s = load_state()
        existing = {p["username"].casefold() for p in s["profiles"]}
        added = 0
        for name in names:
            if name.casefold() in existing:
                continue
            s["profiles"].append({"username": name, "status": "Pending", "added_at": now(),
                                  "comment": "", "message": "", "notes": ""})
            existing.add(name.casefold())
            added += 1
        log_event(s, "—", "Add usernames", "Saved", f"{added} new profile(s) added")
        save_state(s)
    return jsonify(ok=True, added=added, state=s)

@app.patch("/api/profiles/<username>")
def update_profile(username):
    payload = request.get_json(silent=True) or {}
    allowed = {"status", "comment", "message", "notes"}
    if set(payload) - allowed:
        return jsonify(error="Unsupported fields"), 400
    if "status" in payload and payload["status"] not in {"Pending", "In review", "Completed", "Skipped"}:
        return jsonify(error="Invalid status"), 400
    with LOCK:
        s = load_state()
        profile = next((p for p in s["profiles"] if p["username"].casefold() == username.casefold()), None)
        if not profile:
            return jsonify(error="Profile not found"), 404
        profile.update(payload)
        if payload.get("status") in {"Completed", "Skipped"}:
            log_event(s, profile["username"], "Workflow update", payload["status"], "Status saved by user")
        save_state(s)
    return jsonify(ok=True, profile=profile)

@app.delete("/api/profiles/<username>")
def delete_profile(username):
    with LOCK:
        s = load_state()
        before = len(s["profiles"])
        s["profiles"] = [p for p in s["profiles"] if p["username"].casefold() != username.casefold()]
        if len(s["profiles"]) == before:
            return jsonify(error="Profile not found"), 404
        log_event(s, username, "Remove profile", "Removed")
        save_state(s)
    return jsonify(ok=True)

@app.post("/api/templates/<kind>")
def save_templates(kind):
    if kind not in {"comments", "messages"}:
        return jsonify(error="Unknown template type"), 404
    payload = request.get_json(silent=True) or {}
    items = payload.get("items", [])
    if not isinstance(items, list):
        return jsonify(error="items must be a list"), 400
    items = [str(x).strip() for x in items if str(x).strip()]
    if len(items) > 100:
        return jsonify(error="Maximum 100 templates"), 400
    with LOCK:
        s = load_state()
        s[kind] = items
        log_event(s, "—", f"Update {kind}", "Saved", f"{len(items)} template(s)")
        save_state(s)
    return jsonify(ok=True, state=s)

@app.post("/api/next-template/<kind>")
def next_template(kind):
    if kind not in {"comments", "messages"}:
        return jsonify(error="Unknown template type"), 404
    with LOCK:
        s = load_state()
        templates = s[kind]
        if not templates:
            return jsonify(error=f"Add a {kind[:-1]} template first."), 400
        counter_key = "comment_usage" if kind == "comments" else "message_usage"
        used = s[counter_key]
        rotation_every = max(1, min(100, int(s.get("settings", {}).get("rotation_every", 4))))
        # Rotate to the next template after each group of N selections.
        index = (used // rotation_every) % len(templates)
        selected = templates[index]
        s[counter_key] = used + 1
        save_state(s)
        return jsonify(ok=True, template=selected, template_index=index, use_number=s[counter_key],
                       rotation_every=rotation_every)

@app.post("/api/log")
def add_log():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "—"))[:100]
    action = str(payload.get("action", "Review"))[:60]
    status = str(payload.get("status", "Reviewed"))[:40]
    detail = str(payload.get("detail", ""))[:300]
    with LOCK:
        s = load_state()
        log_event(s, username, action, status, detail)
        save_state(s)
    return jsonify(ok=True)

@app.post("/api/settings")
def save_settings():
    payload = request.get_json(silent=True) or {}
    try:
        rotation = int(payload.get("rotation_every", 4))
    except (TypeError, ValueError):
        return jsonify(error="rotation_every must be a number"), 400
    if not 1 <= rotation <= 100:
        return jsonify(error="rotation_every must be between 1 and 100"), 400
    with LOCK:
        s = load_state()
        s["settings"]["rotation_every"] = rotation
        save_state(s)
    return jsonify(ok=True, settings=s["settings"])

@app.post("/api/reset")
def reset_data():
    with LOCK:
        save_state(DEFAULT)
    return jsonify(ok=True)

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    app.run(host=host, port=port, debug=False, threaded=False)
