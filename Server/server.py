# Here lies the Python concerned with the TSW6Ti server backend
# This handles routing, authentication sessions, database persistence, telemetry API proxies and background tasks
# Remember consistency is key

from flask import Flask, jsonify, render_template, send_from_directory, abort, request, redirect, Response
from werkzeug.exceptions import HTTPException
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.serving import WSGIRequestHandler
import sqlite3
import os
import json
import secrets
import hashlib
import re
import io
import shutil
import time
import threading
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone

try:
    from . import legalDocs
    from . import recordings as recEngine
    from . import security as secUtils
except ImportError:
    import legalDocs
    import recordings as recEngine
    import security as secUtils

rootDir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Loads KEY=VALUE configuration pairs from an environment file without overriding existing vars
def loadEnvFile(envPath):
    if not os.path.isfile(envPath):
        return
    with open(envPath, "r", encoding="utf-8") as f:
        for rawLine in f:
            line = rawLine.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            if key.startswith("export "):
                key = key[7:].strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            if key:
                os.environ.setdefault(key, val)

loadEnvFile(os.path.join(rootDir, ".env"))

dbPath = os.path.join(rootDir, "Database", "tsw6ti.db")
storageDir = os.path.join(rootDir, "Storage")
configsDir = os.path.join(storageDir, "Configs")
recordingsDir = os.path.join(storageDir, "Recordings")
guidesDir = os.path.join(rootDir, "Assets", "Guides")
legalDir = os.path.join(rootDir, "Legal")

dataSecret = secUtils.getDataSecret(storageDir)
os.makedirs(configsDir, exist_ok=True)
os.makedirs(recordingsDir, exist_ok=True)
os.makedirs(guidesDir, exist_ok=True)

sessionDays = 7
defaultRecordingRetentionDays = max(0, int(os.environ.get("TSW6_RECORDING_RETENTION_DAYS", "365")))
rawMaxRetention = os.environ.get("TSW6_MAX_RECORDING_RETENTION_DAYS", "").strip()
maxRecordingRetentionDays = max(1, int(rawMaxRetention)) if rawMaxRetention.isdigit() and int(rawMaxRetention) > 0 else None
defaultContactRetentionDays = max(0, int(os.environ.get("TSW6_CONTACT_RETENTION_DAYS", "180")))
retentionSweepIntervalSec = max(60, int(os.environ.get("TSW6_RETENTION_SWEEP_SEC", "3600")))
logClientIPs = os.environ.get("TSW6_LOG_IPS", "").lower() in ("1", "true", "yes")
allowedRetentionDays = (30, 90, 180, 365, 0)

retentionLock = threading.Lock()
lastRetentionSweep = 0.0
rateLimitLock = threading.Lock()
rateLimitSalt = secrets.token_bytes(16)
rateLimitHits = {}

# Initialises the SQLite recordings table to store persistent journey analytics and file references
def initRecordingsTable():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS Recordings (
            recordingID TEXT PRIMARY KEY,
            userID INTEGER NOT NULL,
            title TEXT NOT NULL,
            filePath TEXT NOT NULL,
            startedAt TEXT NOT NULL,
            endedAt TEXT NOT NULL,
            simStartTime TEXT,
            simEndTime TEXT,
            durationSec INTEGER NOT NULL,
            sampleCount INTEGER NOT NULL,
            trainName TEXT,
            routeID INTEGER,
            routeName TEXT,
            direction TEXT,
            originStation TEXT,
            destinationStation TEXT,
            terminusStation TEXT,
            distanceMiles REAL DEFAULT 0,
            topSpeedMph REAL DEFAULT 0,
            avgSpeedMph REAL DEFAULT 0,
            peakAccel REAL DEFAULT 0,
            peakBrake REAL DEFAULT 0,
            overspeedCount INTEGER DEFAULT 0,
            fileSizeBytes INTEGER DEFAULT 0,
            FOREIGN KEY (userID) REFERENCES Users(userID)
        )
    """)
    conn.commit()
    conn.close()

initRecordingsTable()

# Initialises the SQLite contact messages table for user support enquiries and bug reports
def initContactTable():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ContactMessages (
            referenceID TEXT PRIMARY KEY,
            userID INTEGER,
            category TEXT NOT NULL,
            senderName TEXT,
            replyTo TEXT,
            subject TEXT NOT NULL,
            message TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            FOREIGN KEY (userID) REFERENCES Users(userID)
        )
    """)
    conn.commit()
    conn.close()

initContactTable()

contactCategories = {"support", "bug", "privacy", "account", "feature"}
contactCategoryLabels = {
    "support": ("General Support", 0x3B82F6),
    "bug": ("Bug Report", 0xEF4444),
    "privacy": ("Data Protection / GDPR", 0xF59E0B),
    "account": ("Account Assistance", 0x8B5CF6),
    "feature": ("Feature Suggestion", 0x10B981),
}
emailRegex = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
discordWebhookRegex = re.compile(r"^https://(?:ptb\.|canary\.)?discord(?:app)?\.com/api/webhooks/\d+/[\w.-]+/?$")

# Builds an embed payload formatted for Discord incoming webhooks
def buildDiscordContactPayload(refID, category, senderName, replyTo, subject, message, accountUsername=None, createdAt=None):
    label, colour = contactCategoryLabels.get(category, ("Support", 0x8B5CF6))
    titleText = f"[{refID}] {subject}".strip()[:256]
    senderDisplay = senderName or (accountUsername or "Anonymous")
    accountDisplay = f"{accountUsername}" if accountUsername else "Guest (not signed in)"
    replyDisplay = replyTo if replyTo else "Not provided"

    return {
        "username": "TSW6Ti Support",
        "allowed_mentions": {"parse": []},
        "embeds": [
            {
                "title": titleText,
                "description": message[:4096],
                "color": colour,
                "fields": [
                    {"name": "Topic", "value": label[:1024], "inline": True},
                    {"name": "From", "value": senderDisplay[:1024], "inline": True},
                    {"name": "Account", "value": accountDisplay[:1024], "inline": True},
                    {"name": "Reply Email", "value": replyDisplay[:1024], "inline": False},
                ],
                "footer": {"text": f"Reference: {refID}"},
                "timestamp": (createdAt or datetime.now(timezone.utc)).isoformat(),
            }
        ],
    }

# Delivers a JSON payload over HTTP POST to the specified Discord webhook URL
def postDiscordWebhook(webhookURL, payload, timeout=5):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        webhookURL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "TSW6Ti-ContactWebhook/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status

# Spawns a background thread to deliver the contact enquiry to Discord without blocking the client
def dispatchContactDiscordWebhook(refID, category, senderName, replyTo, subject, message, accountUsername=None, createdAt=None):
    webhookURL = os.environ.get("TSW6_CONTACT_WEBHOOK", "").strip()
    if not webhookURL:
        return False
    if not discordWebhookRegex.match(webhookURL):
        app.logger.warning("TSW6_CONTACT_WEBHOOK does not match expected Discord webhook URL format")
        return False

    payload = buildDiscordContactPayload(
        refID,
        category,
        senderName,
        replyTo,
        subject,
        message,
        accountUsername=accountUsername,
        createdAt=createdAt,
    )

    def _send():
        try:
            postDiscordWebhook(webhookURL, payload)
        except Exception as exc:
            app.logger.warning("Failed to deliver Discord contact notification for %s: %s", refID, exc)

    threading.Thread(target=_send, name=f"discord-webhook-{refID}", daemon=True).start()
    return True

# Reads a user's saved JSON dashboard configuration from the storage directory
def readUserConfig(userID):
    configPath = os.path.join(configsDir, f"{userID}.json")
    if not os.path.exists(configPath):
        return {}
    try:
        with open(configPath, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}

# Clamps retention day values against configured server defaults and maximums
def normalizeRetentionDays(value):
    try:
        days = int(value)
    except (TypeError, ValueError):
        days = defaultRecordingRetentionDays
    if days < 0:
        days = defaultRecordingRetentionDays
    if maxRecordingRetentionDays is not None and (days == 0 or days > maxRecordingRetentionDays):
        days = maxRecordingRetentionDays
    return days

# Determines the effective retention window for a given user in days (0 meaning indefinite)
def getUserRecordingRetentionDays(userID):
    cfg = readUserConfig(userID)
    if "recordingRetentionDays" in cfg:
        return normalizeRetentionDays(cfg.get("recordingRetentionDays"))
    return normalizeRetentionDays(defaultRecordingRetentionDays)

# Safely unlinks expired recording files from disk while strictly ensuring paths stay within the storage bounds
def _safeRemoveRecordingFiles(relPaths):
    removed = 0
    baseDir = os.path.abspath(recordingsDir)
    for relPath in relPaths:
        if not relPath:
            continue
        absPath = os.path.abspath(os.path.join(baseDir, relPath))
        if not (absPath == baseDir or absPath.startswith(baseDir + os.sep)):
            continue
        if os.path.isfile(absPath):
            try:
                os.remove(absPath)
                removed += 1
            except OSError:
                pass
    return removed

# Produces a salted hash key for ephemeral client rate limiting without recording raw client IPs
def _clientRateKey(scope):
    rawAddr = (request.remote_addr or "local").encode("utf-8")
    digest = hashlib.sha256(rateLimitSalt + scope.encode("utf-8") + b":" + rawAddr).hexdigest()
    return f"{scope}:{digest}"

# Checks whether a client has exceeded allowed request hits within a sliding time window
def _isRateLimited(scope, maxHits, windowSec):
    key = _clientRateKey(scope)
    cutoff = time.monotonic() - windowSec
    with rateLimitLock:
        recent = [ts for ts in rateLimitHits.get(key, []) if ts > cutoff]
        if recent:
            rateLimitHits[key] = recent
        else:
            rateLimitHits.pop(key, None)
        return len(recent) >= maxHits

# Logs a rate limit attempt for the requesting client and prunes aged entries
def _recordRateHit(scope, windowSec):
    key = _clientRateKey(scope)
    nowMono = time.monotonic()
    cutoff = nowMono - windowSec
    with rateLimitLock:
        recent = [ts for ts in rateLimitHits.get(key, []) if ts > cutoff]
        recent.append(nowMono)
        rateLimitHits[key] = recent

# Clears recorded rate limiting hits after successful validation or authentication
def _clearRateHits(scope):
    key = _clientRateKey(scope)
    with rateLimitLock:
        rateLimitHits.pop(key, None)

# Prunes expired session tokens from the Sessions database table
def pruneExpiredSessions(cursor, nowDT=None):
    nowDT = nowDT or datetime.now(timezone.utc)
    cursor.execute("DELETE FROM Sessions WHERE expiresAt < ?", (nowDT.isoformat(),))
    return cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0

# Prunes contact enquiries older than the configured contact message retention period
def pruneExpiredContactMessages(cursor, nowDT=None):
    if defaultContactRetentionDays <= 0:
        return 0
    nowDT = nowDT or datetime.now(timezone.utc)
    cutoffISO = (nowDT - timedelta(days=defaultContactRetentionDays)).isoformat()
    cursor.execute("DELETE FROM ContactMessages WHERE createdAt < ?", (cutoffISO,))
    return cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0

# Removes expired journey recording database rows that exceed owner retention policies
def pruneExpiredRecordings(cursor, userID=None, nowDT=None):
    nowDT = nowDT or datetime.now(timezone.utc)
    if userID is not None:
        cursor.execute("SELECT recordingID, userID, filePath, endedAt FROM Recordings WHERE userID = ?", (userID,))
    else:
        cursor.execute("SELECT recordingID, userID, filePath, endedAt FROM Recordings")
    rows = cursor.fetchall()
    if not rows:
        return []

    retentionCache = {}
    expiredIDs = []
    expiredPaths = []

    for recID, recUID, relPath, endedAt in rows:
        if recUID not in retentionCache:
            retentionCache[recUID] = getUserRecordingRetentionDays(recUID)
        days = retentionCache[recUID]
        if days <= 0 or not endedAt:
            continue
        try:
            endedDT = datetime.fromisoformat(str(endedAt).replace("Z", "+00:00"))
            if endedDT.tzinfo is None:
                endedDT = endedDT.replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if endedDT < (nowDT - timedelta(days=days)):
            expiredIDs.append(recID)
            expiredPaths.append(relPath)

    for idx in range(0, len(expiredIDs), 500):
        chunk = expiredIDs[idx:idx + 500]
        placeholders = ",".join("?" for _ in chunk)
        cursor.execute(f"DELETE FROM Recordings WHERE recordingID IN ({placeholders})", chunk)

    return expiredPaths

# Executes a complete retention sweep across sessions, contact tickets and journey recordings
def runRetentionCleanup():
    global lastRetentionSweep
    lastRetentionSweep = time.monotonic()
    if not os.path.exists(dbPath):
        return {"sessionsPruned": 0, "recordingsPruned": 0, "contactPruned": 0}
    nowDT = datetime.now(timezone.utc)
    conn = sqlite3.connect(dbPath)
    try:
        cursor = conn.cursor()
        sessionsPruned = pruneExpiredSessions(cursor, nowDT=nowDT)
        expiredPaths = pruneExpiredRecordings(cursor, nowDT=nowDT)
        try:
            contactPruned = pruneExpiredContactMessages(cursor, nowDT=nowDT)
        except sqlite3.OperationalError:
            contactPruned = 0
        conn.commit()
    except sqlite3.OperationalError:
        conn.close()
        return {"sessionsPruned": 0, "recordingsPruned": 0, "contactPruned": 0}
    conn.close()
    _safeRemoveRecordingFiles(expiredPaths)
    return {
        "sessionsPruned": sessionsPruned,
        "recordingsPruned": len(expiredPaths),
        "contactPruned": contactPruned,
    }

# Triggers retention cleanup when the minimum sweep interval has elapsed
def maybeRunRetentionCleanup():
    global lastRetentionSweep
    nowMono = time.monotonic()
    if nowMono - lastRetentionSweep < retentionSweepIntervalSec:
        return
    with retentionLock:
        nowMono = time.monotonic()
        if nowMono - lastRetentionSweep < retentionSweepIntervalSec:
            return
        lastRetentionSweep = nowMono
    runRetentionCleanup()

runRetentionCleanup()

# Hashes an authentication session token with SHA-256 for secure database storage
def hashToken(token):
    return hashlib.sha256(token.encode()).hexdigest()

# Creates and persists an authenticated user session returning the raw bearer token
def createSession(cursor, userID):
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=sessionDays)
    cursor.execute("INSERT INTO Sessions (tokenHash, userID, expiresAt) VALUES (?, ?, ?)", (hashToken(token), userID, expires.isoformat()))
    return token

# Extracts the raw bearer token string from the HTTP Authorization header
def getBearerToken():
    header = request.headers.get("Authorization", "")
    return header[7:] if header.startswith("Bearer ") else None

# Verifies the active bearer token and returns the corresponding authenticated user ID
def getSessionUserID(cursor):
    token = getBearerToken()
    if not token:
        return None
    tokenHash = hashToken(token)
    cursor.execute("SELECT userID, expiresAt FROM Sessions WHERE tokenHash = ?", (tokenHash,))
    row = cursor.fetchone()
    if row is None:
        return None
    if datetime.fromisoformat(row[1]) < datetime.now(timezone.utc):
        cursor.execute("DELETE FROM Sessions WHERE tokenHash = ?", (tokenHash,))
        cursor.connection.commit()
        return None
    return row[0]

# Computes the maximum allowed HTTP request body size in bytes from the environment
def _parseMaxContentBytes():
    try:
        mb = int(os.environ.get("TSW6_MAX_CONTENT_MB", "16"))
    except ValueError:
        mb = 16
    return max(1, mb) * 1024 * 1024

# Validates and strips single-line string fields checking length and illegal control characters
def _cleanSingleLineField(value, maxLen, fieldLabel):
    if not isinstance(value, str):
        return None, f"Invalid {fieldLabel}"
    cleaned = value.strip()
    if not cleaned:
        return None, f"Missing {fieldLabel}"
    if re.search(r"[\x00-\x1f\x7f]", cleaned):
        return None, f"{fieldLabel} contains invalid control characters"
    if len(cleaned) > maxLen:
        return None, f"{fieldLabel} must be {maxLen} characters or fewer"
    return cleaned, None

app = Flask(__name__, template_folder='../Client/HTML', static_folder='../Client', static_url_path='/Client')
app.config["MAX_CONTENT_LENGTH"] = _parseMaxContentBytes()

noStorePrefixes = ("/api/", "/connections", "/session", "/login", "/register", "/logout")
publicAssetPrefixes = ("Guides/", "Images/")
contentSecurityPolicy = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self'; "
    "connect-src 'self' http: https:; "
    "form-action 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'self'"
)

# Intercepts incoming requests to run background retention pruning periodically
@app.before_request
def triggerPeriodicRetentionCleanup():
    if request.path.startswith(("/Client/", "/Assets/")):
        return
    maybeRunRetentionCleanup()

# Attaches strict security headers and disables caching on sensitive stateful endpoints
@app.after_request
def applySecurityHeaders(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Content-Security-Policy", contentSecurityPolicy)
    if request.path.startswith(noStorePrefixes):
        response.headers["Cache-Control"] = "no-store"
    return response

errorMessages = {
    400: ("Bad Request", "The server could not understand your request. Please check your input and try again."),
    401: ("Authorisation Required", "Please sign in to access this page or resource."),
    403: ("Access Forbidden", "You do not have permission to access this resource."),
    404: ("Page Not Found", "The page or resource you requested does not exist or may have been moved."),
    405: ("Method Not Allowed", "This route does not accept the requested HTTP method."),
    413: ("Payload Too Large", "The request payload exceeded the maximum allowed size."),
    429: ("Too Many Requests", "You have sent too many requests in a short period. Please wait a moment and try again."),
    500: ("Internal Server Error", "Something went wrong on our side while handling your request. Please try again shortly."),
}

# Renders either a JSON error message for API routes or the friendly HTML error page for browsers
def renderErrorResponse(code, fallbackTitle="Error", fallbackDesc="An unexpected error occurred."):
    title, desc = errorMessages.get(code, (fallbackTitle, fallbackDesc))
    prefersJSON = request.path.startswith(noStorePrefixes) or (
        request.accept_mimetypes["application/json"] > request.accept_mimetypes["text/html"]
    )
    if prefersJSON:
        return jsonify({"status": "error", "code": code, "message": title}), code
    return render_template(
        "Public/error.html",
        error={"code": code, "title": title, "description": desc},
    ), code

# Catches standard Werkzeug HTTP exceptions and formats uniform responses
@app.errorhandler(HTTPException)
def handleHttpException(exc):
    code = exc.code or 500
    return renderErrorResponse(code, fallbackTitle=exc.name or "Error")

# Traps unexpected server exceptions and serves a clean 500 internal error
@app.errorhandler(Exception)
def handleUnexpectedException(exc):
    app.logger.exception("Unhandled server error on %s", request.path)
    return renderErrorResponse(500)

# Serves the landing homepage
@app.route("/")
@app.route("/index.html")
def index():
    return render_template("Public/index.html")

# Serves the authentication page for login and user registration
@app.route("/auth")
@app.route("/auth.html")
def auth():
    return render_template("Public/auth.html")

# Serves the bridge connection setup page
@app.route("/connect")
def connect():
    return render_template("Public/connect.html")

# Serves the account profile and data management dashboard
@app.route("/account")
@app.route("/account.html")
def accountPage():
    return render_template("Public/account.html")

# Serves the contact enquiry and support submission page
@app.route("/contact")
@app.route("/contact.html")
def contactPage():
    return render_template("Public/contact.html")

# Serves the project credits and acknowledgement page
@app.route("/credits")
@app.route("/credits.html")
def creditsPage():
    return render_template("Public/credits.html")

# Helper function to load and render Markdown legal documents in the legal viewer template
def renderLegalDocument(docSlug):
    doc = legalDocs.loadLegalDocument(docSlug, legalDir)
    if doc is None:
        abort(404)
    return render_template("Public/legal.html", doc=doc)

# Serves the privacy policy document page
@app.route("/privacy-policy")
def privacyPolicyPage():
    return renderLegalDocument("privacy-policy")

# Serves the terms of service and conditions document page
@app.route("/terms-and-conditions")
@app.route("/terms-of-service")
def termsAndConditionsPage():
    return renderLegalDocument("terms-and-conditions")

# Serves generic legal documents by their slug identifier
@app.route("/legal/<docSlug>")
def legalDocumentPage(docSlug):
    return renderLegalDocument(docSlug)

# Allows downloading legal documents as Word docx attachments when available
@app.route("/legal/<docSlug>/download")
def downloadLegalDocument(docSlug):
    doc = legalDocs.loadLegalDocument(docSlug, legalDir)
    if doc is None or not doc.get("available") or not doc.get("filename"):
        abort(404)
    return send_from_directory(
        legalDir,
        doc["filename"],
        as_attachment=True,
        download_name=doc["filename"],
        mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )

# Detects mobile user agents to redirect them away from desktop telemetry interfaces
def isMobileRequest():
    ua = request.headers.get("User-Agent", "").lower()
    return any(k in ua for k in ("iphone", "ipod", "android", "windows phone", "iemobile", "blackberry", "mobile"))

# Serves the real-time telemetry HUD dashboard interface
@app.route("/dashboard")
@app.route("/dashboard.html")
def dashboard():
    if isMobileRequest():
        return redirect("/connect?from_telem=1")
    return render_template("Telemetry Interface/dashboard.html")

# Serves the telemetry interface display settings page
@app.route("/settings")
@app.route("/settings.html")
def settings():
    if isMobileRequest():
        return redirect("/connect?from_telem=1")
    return render_template("Telemetry Interface/settings.html")

# Serves the trip recordings history and analytics explorer
@app.route("/recordings")
@app.route("/recordings.html")
def recordingsPage():
    if isMobileRequest():
        return redirect("/connect?from_telem=1")
    return render_template("Telemetry Interface/recordings.html")

# Serves the in-app documentation and knowledge guides portal
@app.route("/guides")
@app.route("/guides.html")
@app.route("/guides/<path:guideID>")
def guidesPage(guideID=None):
    if isMobileRequest():
        return redirect("/connect?from_telem=1")
    return render_template("Telemetry Interface/guides.html")

# Serves static assets such as guide media from the Assets directory
@app.route("/Assets/<path:filename>")
def serveAssets(filename):
    normalized = filename.replace("\\", "/").lstrip("/")
    if not normalized.startswith(publicAssetPrefixes):
        abort(404)
    return send_from_directory("../Assets", normalized)

# Serves project brand images and icons
@app.route("/Images/<path:filename>")
def serveImages(filename):
    return send_from_directory("../Assets/Images", filename)

# Serves the favicon icon file from the assets image directory
@app.route("/favicon.ico")
def favicon():
    imagesDir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "Assets", "Images"))
    return send_from_directory(
        imagesDir,
        "favicon.ico",
        mimetype="image/x-icon",
    )

# Serves the Chromium browser bridge extension archive for download
@app.route("/extensions/chromium.zip")
def downloadChromiumExtension():
    distDir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "Extensions", "dist"))
    if not os.path.isdir(distDir):
        abort(404)
    zipPath = os.path.join(distDir, "tsw6ti-connector-chromium.zip")
    if not os.path.isfile(zipPath):
        abort(404)
    return send_from_directory(
        distDir,
        "tsw6ti-connector-chromium.zip",
        mimetype="application/zip",
        as_attachment=True,
    )

# Serves the signed self-hosted Firefox XPI connector extension
@app.route("/extensions/firefox.xpi")
def downloadFirefoxExtension():
    pluginsDir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "Extensions", "Plugins"))
    if not os.path.isdir(pluginsDir):
        abort(404)
    xpis = sorted(
        f for f in os.listdir(pluginsDir)
        if f.lower().endswith(".xpi") and os.path.isfile(os.path.join(pluginsDir, f))
    )
    if not xpis:
        abort(404)
    return send_from_directory(
        pluginsDir,
        xpis[-1],
        mimetype="application/x-xpinstall",
        as_attachment=False,
    )

# Authenticates a user with username and password and issues a new bearer session token
@app.route("/login", methods=["POST"])
def login():
    if _isRateLimited("login_fail", maxHits=10, windowSec=300):
        return jsonify({
            "status": "error",
            "message": "Too many failed login attempts. Please wait a few minutes before trying again.",
        }), 429

    data = request.get_json(silent=True) or {}
    username = str(data.get("username") or "").strip()
    password = str(data.get("password") or "")

    if not username or not password:
        return jsonify({"status": "error", "message": "Missing username or password"}), 400

    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    cursor.execute("SELECT userID, username, passwordHash FROM Users WHERE username = ?", (username,))
    user = cursor.fetchone()

    if user is None or not check_password_hash(user[2], password):
        conn.close()
        _recordRateHit("login_fail", windowSec=300)
        return jsonify({"status": "error", "message": "Invalid username or password"}), 401

    _clearRateHits("login_fail")
    token = createSession(cursor, user[0])
    conn.commit()
    conn.close()

    return jsonify({"status": "success", "message": "Login successful", "token": token})

# Validates an active session bearer token and returns the current user profile
@app.route("/session", methods=["GET"])
def session():
    token = getBearerToken()
    if not token:
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    cursor.execute("SELECT Users.username, Sessions.expiresAt FROM Sessions JOIN Users ON Users.userID = Sessions.userID WHERE tokenHash = ?", (hashToken(token),))
    row = cursor.fetchone()
    if row is not None and datetime.fromisoformat(row[1]) < datetime.now(timezone.utc):
        cursor.execute("DELETE FROM Sessions WHERE tokenHash = ?", (hashToken(token),))
        conn.commit()
        row = None
    conn.close()

    if row is None:
        return jsonify({"status": "error", "message": "Session expired"}), 401
    return jsonify({"status": "success", "username": row[0]})

# Terminates the current authenticated session and clears the session token
@app.route("/logout", methods=["POST"])
def logout():
    token = getBearerToken()
    if token:
        conn = sqlite3.connect(dbPath)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM Sessions WHERE tokenHash = ?", (hashToken(token),))
        conn.commit()
        conn.close()
    return jsonify({"status": "success", "message": "Logged out"})

# Safely decrypts encrypted sensitive credentials, returning an empty string on decipher failure
def _safeDecrypt(val):
    try:
        return secUtils.decryptValue(val, dataSecret)
    except Exception:
        return ""

# Retrieves the list of saved train sim bridge connections for the authenticated user
@app.route("/connections", methods=["GET"])
def getConnections():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    cursor.execute("SELECT connectionID, ipAddress, apiKey FROM Connections WHERE userID = ? ORDER BY connectionID DESC", (userID,))
    connections = [
        {
            "connectionID": r[0],
            "ipAddress": _safeDecrypt(r[1]),
            "apiKey": _safeDecrypt(r[2])
        }
        for r in cursor.fetchall()
    ]
    conn.close()
    return jsonify({"status": "success", "connections": connections})

# Saves a new train sim bridge connection endpoint with encrypted credentials
@app.route("/connections", methods=["POST"])
def addConnection():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        conn.close()
        return jsonify({"status": "error", "message": "Invalid JSON payload"}), 400

    ipAddress, ipErr = _cleanSingleLineField(data.get("ipAddress"), 255, "IP address")
    if ipErr:
        conn.close()
        return jsonify({"status": "error", "message": ipErr}), 400

    apiKey, keyErr = _cleanSingleLineField(data.get("apiKey"), 256, "API key")
    if keyErr:
        conn.close()
        return jsonify({"status": "error", "message": keyErr}), 400

    cursor.execute("SELECT ipAddress, apiKey FROM Connections WHERE userID = ?", (userID,))
    alreadyExists = any(
        _safeDecrypt(r[0]) == ipAddress and _safeDecrypt(r[1]) == apiKey
        for r in cursor.fetchall()
    )
    if not alreadyExists:
        cursor.execute(
            "INSERT INTO Connections (userID, ipAddress, apiKey) VALUES (?, ?, ?)",
            (
                userID,
                secUtils.encryptValue(ipAddress, dataSecret),
                secUtils.encryptValue(apiKey, dataSecret),
            ),
        )
        conn.commit()
    conn.close()
    return jsonify({"status": "success", "message": "Connection saved"})

# Removes a saved bridge connection belonging to the authenticated user
@app.route("/connections/<int:connectionID>", methods=["DELETE"])
def deleteConnection(connectionID):
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    cursor.execute("DELETE FROM Connections WHERE connectionID = ? AND userID = ?", (connectionID, userID))
    conn.commit()
    conn.close()
    return jsonify({"status": "success", "message": "Connection deleted"})

# Fetches the user's custom dashboard widget layout and visual settings
@app.route("/api/dashboard-config", methods=["GET"])
def getDashboardConfig():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    conn.close()
    if userID is None:
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    configPath = os.path.join(configsDir, f"{userID}.json")
    if not os.path.exists(configPath):
        return jsonify({"status": "success", "userID": userID, "config": None})

    try:
        with open(configPath, "r", encoding="utf-8") as f:
            config = json.load(f)
        return jsonify({"status": "success", "userID": userID, "config": config})
    except Exception:
        return jsonify({"status": "success", "userID": userID, "config": None})

# Persists updated dashboard widget arrangement, theme and accent color choices
@app.route("/api/dashboard-config", methods=["POST"])
def saveDashboardConfig():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    conn.close()
    if userID is None:
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"status": "error", "message": "Invalid dashboard configuration"}), 400

    configPath = os.path.join(configsDir, f"{userID}.json")
    existing = {}
    if os.path.exists(configPath):
        try:
            with open(configPath, "r", encoding="utf-8") as f:
                loaded = json.load(f)
                if isinstance(loaded, dict):
                    existing = loaded
        except Exception:
            existing = {}

    hasModules = "modules" in data
    hasTheme = isinstance(data.get("theme"), str) and bool(data.get("theme").strip())
    hasAccent = isinstance(data.get("accentColor"), str) and bool(data.get("accentColor").strip())

    if hasModules and not isinstance(data.get("modules"), list):
        return jsonify({"status": "error", "message": "Invalid dashboard modules"}), 400
    if not hasModules and not hasTheme and not hasAccent:
        return jsonify({"status": "error", "message": "Invalid dashboard configuration"}), 400

    modules = data.get("modules") if hasModules else existing.get("modules")
    theme = data.get("theme").strip() if hasTheme else existing.get("theme", "default")
    accentColor = data.get("accentColor").strip() if hasAccent else existing.get("accentColor")

    payload = {
        "userID": userID,
        "grid": {"cols": 5, "rows": 3},
        "theme": theme,
        "updatedAt": datetime.now(timezone.utc).isoformat()
    }
    if accentColor:
        payload["accentColor"] = accentColor
    if isinstance(modules, list):
        payload["modules"] = modules
    if "recordingRetentionDays" in existing:
        payload["recordingRetentionDays"] = normalizeRetentionDays(existing.get("recordingRetentionDays"))

    with open(configPath, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    return jsonify({"status": "success", "message": "Dashboard configuration saved", "config": payload})

# Parses a comma- or space-separated geographic coordinate string into lat/lon floats
def parseCoordPair(val):
    if val is None:
        return None
    parts = str(val).replace(",", " ").strip().split()
    if len(parts) < 2:
        return None
    try:
        return {"lon": float(parts[0]), "lat": float(parts[1])}
    except ValueError:
        return None

# Loads the full catalogue of routes and station waypoints from the database
def fetchRoutesCatalog(cursor):
    cursor.execute("SELECT routeID, routeName FROM Routes ORDER BY routeID ASC")
    routeRows = cursor.fetchall()

    routes = []
    for rID, rName in routeRows:
        cursor.execute("""
            SELECT Stations.stationID, Stations.stationName,
                   Stations.forStart, Stations.forEnd,
                   Stations.backStart, Stations.backEnd,
                   RouteStations.position
            FROM RouteStations
            JOIN Stations ON RouteStations.stationID = Stations.stationID
            WHERE RouteStations.routeID = ?
            ORDER BY RouteStations.position ASC
        """, (rID,))
        stationRows = cursor.fetchall()
        stations = []
        for sID, sName, fStart, fEnd, bStart, bEnd, pos in stationRows:
            forStartCoord = parseCoordPair(fStart)
            forEndCoord = parseCoordPair(fEnd)
            backStartCoord = parseCoordPair(bStart)
            backEndCoord = parseCoordPair(bEnd)
            anchor = forStartCoord or forEndCoord or backStartCoord or backEndCoord
            if not anchor:
                continue
            stations.append({
                "stationID": sID,
                "name": sName,
                "position": pos,
                "lat": anchor["lat"],
                "lon": anchor["lon"],
                "forStart": forStartCoord or anchor,
                "forEnd": forEndCoord or forStartCoord or anchor,
                "backStart": backStartCoord or forStartCoord or anchor,
                "backEnd": backEndCoord or backStartCoord or forEndCoord or anchor
            })
        routes.append({
            "routeID": rID,
            "routeName": rName,
            "stations": stations
        })
    return routes

# Serves the complete catalogue of known routes and station stop coordinates
@app.route("/api/routes", methods=["GET"])
def getRoutesData():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    routes = fetchRoutesCatalog(cursor)
    conn.close()
    return jsonify({"status": "success", "routes": routes})

# Lists all telemetry recordings owned by the signed-in user ordered by date
@app.route("/api/recordings", methods=["GET"])
def listRecordings():
    conn = sqlite3.connect(dbPath)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    cursor.execute("""
        SELECT recordingID, title, startedAt, endedAt, simStartTime, simEndTime,
               durationSec, sampleCount, trainName, routeID, routeName, direction,
               originStation, destinationStation, terminusStation, distanceMiles,
               topSpeedMph, avgSpeedMph, peakAccel, peakBrake, overspeedCount, fileSizeBytes
        FROM Recordings
        WHERE userID = ?
        ORDER BY startedAt DESC
    """, (userID,))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return jsonify({"status": "success", "recordings": rows})

# Reconciles, compresses, and saves a completed telemetry recording stream
@app.route("/api/recordings", methods=["POST"])
def createRecording():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("samples"), list) or len(data["samples"]) == 0:
        conn.close()
        return jsonify({"status": "error", "message": "Recording contains no telemetry samples"}), 400

    routesCatalog = fetchRoutesCatalog(cursor)
    meta = recEngine.reconcileAndSaveRecording(userID, data, routesCatalog, recordingsDir)

    cursor.execute("""
        INSERT INTO Recordings (
            recordingID, userID, title, filePath, startedAt, endedAt,
            simStartTime, simEndTime, durationSec, sampleCount, trainName,
            routeID, routeName, direction, originStation, destinationStation,
            terminusStation, distanceMiles, topSpeedMph, avgSpeedMph,
            peakAccel, peakBrake, overspeedCount, fileSizeBytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        meta["recordingID"], userID, meta["title"], meta["filePath"],
        meta["startedAt"], meta["endedAt"], meta["simStartTime"], meta["simEndTime"],
        meta["durationSec"], meta["sampleCount"], meta["trainName"],
        meta["routeID"], meta["routeName"], meta["direction"],
        meta["originStation"], meta["destinationStation"], meta["terminusStation"],
        meta["distanceMiles"], meta["topSpeedMph"], meta["avgSpeedMph"],
        meta["peakAccel"], meta["peakBrake"], meta["overspeedCount"], meta["fileSizeBytes"]
    ))
    conn.commit()
    conn.close()
    return jsonify({"status": "success", "recording": meta})

# Queries a recording database row ensuring ownership matches the active session
def _getUserRecordingRow(recordingID):
    conn = sqlite3.connect(dbPath)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return None, None, 401
    cursor.execute("SELECT * FROM Recordings WHERE recordingID = ? AND userID = ?", (recordingID, userID))
    row = cursor.fetchone()
    conn.close()
    if row is None:
        return userID, None, 404
    return userID, dict(row), 200

# Fetches detailed telemetry samples and metadata for a specific saved journey recording
@app.route("/api/recordings/<recordingID>", methods=["GET"])
def getRecordingDetail(recordingID):
    _, row, statusCode = _getUserRecordingRow(recordingID)
    if statusCode == 401:
        return jsonify({"status": "error", "message": "Not authenticated"}), 401
    if statusCode == 404:
        return jsonify({"status": "error", "message": "Recording not found"}), 404

    absPath = os.path.join(recordingsDir, row["filePath"])
    if not os.path.exists(absPath):
        return jsonify({"status": "error", "message": "Recording archive file missing"}), 404

    archive = recEngine.loadRecordingArchive(absPath)
    archive["meta"]["fileSizeBytes"] = row.get("fileSizeBytes", 0)
    return jsonify({"status": "success", "recording": archive})

# Deletes a journey recording entry from the database and permanently removes its archive file
@app.route("/api/recordings/<recordingID>", methods=["DELETE"])
def deleteRecording(recordingID):
    conn = sqlite3.connect(dbPath)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    cursor.execute("SELECT filePath FROM Recordings WHERE recordingID = ? AND userID = ?", (recordingID, userID))
    row = cursor.fetchone()
    if row is None:
        conn.close()
        return jsonify({"status": "error", "message": "Recording not found"}), 404

    absPath = os.path.join(recordingsDir, row["filePath"])
    cursor.execute("DELETE FROM Recordings WHERE recordingID = ? AND userID = ?", (recordingID, userID))
    conn.commit()
    conn.close()

    if os.path.exists(absPath):
        try:
            os.remove(absPath)
        except OSError:
            pass

    return jsonify({"status": "success", "message": "Recording deleted"})

# Generates and serves a formatted journey report PDF download for a recording
@app.route("/api/recordings/<recordingID>/pdf", methods=["GET"])
def downloadRecordingPdf(recordingID):
    _, row, statusCode = _getUserRecordingRow(recordingID)
    if statusCode == 401:
        return jsonify({"status": "error", "message": "Not authenticated"}), 401
    if statusCode == 404:
        return jsonify({"status": "error", "message": "Recording not found"}), 404

    absPath = os.path.join(recordingsDir, row["filePath"])
    if not os.path.exists(absPath):
        return jsonify({"status": "error", "message": "Recording archive file missing"}), 404

    archive = recEngine.loadRecordingArchive(absPath)
    try:
        pdfBytes = recEngine.generateRecordingPdf(archive)
    except ImportError:
        return jsonify({
            "status": "error",
            "message": "Server PDF library not installed. Run: pip install fpdf2"
        }), 500

    safeRecordingID = re.sub(r"[^A-Za-z0-9_-]+", "_", recordingID).strip("_") or "export"
    filename = f"TSW6_Recording_{safeRecordingID}.pdf"
    return Response(
        pdfBytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )

frontmatterRegex = re.compile(r"^\ufeff?\s*---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|$)", re.DOTALL)
headingH1Regex = re.compile(r"^\s*#\s+(.+?)\s*$", re.MULTILINE)
mdImageRegex = re.compile(r"!\[[^\]]*\]\([^)]+\)")

# Separates YAML frontmatter metadata from Markdown content body
def _splitGuideFrontmatter(rawText):
    text = rawText.lstrip("\ufeff")
    meta = {}
    match = frontmatterRegex.match(text)
    if match:
        for line in match.group(1).splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                cleanKey = key.strip().lower()
                cleanVal = value.strip().strip('"').strip("'")
                if cleanKey:
                    meta[cleanKey] = cleanVal
        body = text[match.end():].lstrip("\r\n")
        return meta, body
    return meta, text

# Extracts a clean plain-text summary sentence from Markdown prose
def _extractGuideSummary(markdownBody):
    inCodeBlock = False
    for rawLine in markdownBody.splitlines():
        line = rawLine.strip()
        if line.startswith("```"):
            inCodeBlock = not inCodeBlock
            continue
        if inCodeBlock or not line:
            continue
        if line.startswith("#") or line.startswith("---") or line.startswith("___") or line.startswith("***"):
            continue
        if line.startswith("!["):
            continue
        if line.startswith(">"):
            line = line.lstrip(">").strip()
            if not line or line.startswith("[!"):
                continue
        if line.startswith(("- ", "* ", "+ ")):
            continue
        if re.match(r"^\d+\.\s+", line):
            continue
        plain = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", line)
        plain = re.sub(r"[`*_~]", "", plain).strip()
        if len(plain) >= 12:
            return plain[:160] + ("..." if len(plain) > 160 else "")
    return ""

# Reads and parses a guide Markdown file into structured article metadata and body
def _readGuideEntry(absPath, relPath, includeContent=False):
    with open(absPath, "r", encoding="utf-8", errors="replace") as f:
        rawText = f.read()

    meta, body = _splitGuideFrontmatter(rawText)
    stem = os.path.splitext(relPath)[0].replace(os.sep, "/")
    fileName = os.path.basename(relPath)

    title = meta.get("title")
    if not title:
        h1Match = headingH1Regex.search(body)
        title = h1Match.group(1).strip() if h1Match else stem.replace("-", " ").replace("_", " ")

    summary = meta.get("description") or meta.get("summary") or _extractGuideSummary(body)
    words = re.findall(r"\b\w+\b", body)
    wordCount = len(words)
    imageCount = len(mdImageRegex.findall(body))
    mtime = datetime.fromtimestamp(os.path.getmtime(absPath), tz=timezone.utc).isoformat()

    entry = {
        "slug": stem,
        "fileName": fileName,
        "relativePath": relPath.replace(os.sep, "/"),
        "title": title,
        "summary": summary,
        "theme": meta.get("theme", ""),
        "meta": meta,
        "wordCount": wordCount,
        "readMinutes": max(1, (wordCount + 179) // 180) if wordCount > 0 else 1,
        "imageCount": imageCount,
        "updatedAt": mtime,
    }
    if includeContent:
        entry["markdown"] = body
        entry["rawMarkdown"] = rawText
    return entry

# Discovers all markdown guide documents within the guides directory tree
def _discoverGuideFiles():
    discovered = []
    if not os.path.isdir(guidesDir):
        return discovered

    for root, dirs, files in os.walk(guidesDir):
        dirs[:] = sorted([d for d in dirs if not d.startswith(".")], key=str.lower)
        for fname in sorted(files, key=str.lower):
            if fname.startswith(".") or not fname.lower().endswith(".md"):
                continue
            absPath = os.path.join(root, fname)
            relPath = os.path.relpath(absPath, guidesDir)
            discovered.append((absPath, relPath))
    return discovered

# Returns an index listing all available guides with reading metrics and summaries
@app.route("/api/guides", methods=["GET"])
def apiListGuides():
    guides = []
    for absPath, relPath in _discoverGuideFiles():
        try:
            guides.append(_readGuideEntry(absPath, relPath, includeContent=False))
        except OSError:
            continue
    return jsonify({"status": "success", "guides": guides})

# Fetches a specific guide article including full Markdown content
@app.route("/api/guides/<path:guideID>", methods=["GET"])
def apiGetGuide(guideID):
    normalized = guideID.strip().strip("/").replace("\\", "/")
    if normalized.lower().endswith(".md"):
        normalized = normalized[:-3]

    target = normalized.lower()
    for absPath, relPath in _discoverGuideFiles():
        stem = os.path.splitext(relPath)[0].replace(os.sep, "/")
        if stem.lower() == target:
            entry = _readGuideEntry(absPath, relPath, includeContent=True)
            return jsonify({"status": "success", "guide": entry})

    return jsonify({"status": "error", "message": "Guide not found"}), 404

# Parses the project README into structured sections for display on the portal
@app.route("/api/readme", methods=["GET"])
def apiGetReadme():
    readmePath = os.path.join(rootDir, "README.md")
    if not os.path.isfile(readmePath):
        return jsonify({"status": "error", "message": "README.md not found", "sections": []}), 404

    try:
        with open(readmePath, "r", encoding="utf-8") as f:
            rawText = f.read()
    except OSError as err:
        return jsonify({"status": "error", "message": f"Could not read README.md: {err}", "sections": []}), 500

    sections = []
    currentTitle = None
    currentLines = []
    introLines = []

    for line in rawText.splitlines():
        match = re.match(r"^##\s+(.+)$", line)
        if match:
            if currentTitle is not None:
                sections.append({
                    "title": currentTitle.strip(),
                    "content": "\n".join(currentLines).strip()
                })
            currentTitle = match.group(1).strip()
            currentLines = []
        elif currentTitle is not None:
            currentLines.append(line)
        else:
            introLines.append(line)

    if currentTitle is not None:
        sections.append({
            "title": currentTitle.strip(),
            "content": "\n".join(currentLines).strip()
        })

    return jsonify({
        "status": "success",
        "intro": "\n".join(introLines).strip(),
        "sections": sections
    })

# Returns an account overview including connection counts, active sessions, and retention settings
@app.route("/api/account", methods=["GET"])
def getAccountOverview():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    cursor.execute("SELECT username FROM Users WHERE userID = ?", (userID,))
    userRow = cursor.fetchone()
    if userRow is None:
        conn.close()
        return jsonify({"status": "error", "message": "User not found"}), 404

    cursor.execute("SELECT COUNT(*) FROM Connections WHERE userID = ?", (userID,))
    connectionCount = cursor.fetchone()[0]

    cursor.execute("SELECT COUNT(*) FROM Recordings WHERE userID = ?", (userID,))
    recordingCount = cursor.fetchone()[0]

    pruneExpiredSessions(cursor)
    conn.commit()

    cursor.execute("SELECT COUNT(*) FROM Sessions WHERE userID = ?", (userID,))
    sessionCount = cursor.fetchone()[0]

    token = getBearerToken()
    sessionExpiresAt = None
    if token:
        cursor.execute("SELECT expiresAt FROM Sessions WHERE tokenHash = ?", (hashToken(token),))
        expRow = cursor.fetchone()
        if expRow:
            sessionExpiresAt = expRow[0]

    conn.close()
    configPath = os.path.join(configsDir, f"{userID}.json")

    return jsonify({
        "status": "success",
        "account": {
            "userID": userID,
            "username": userRow[0],
            "connectionCount": connectionCount,
            "recordingCount": recordingCount,
            "hasDashboardConfig": os.path.exists(configPath),
            "activeSessionCount": sessionCount,
            "sessionExpiresAt": sessionExpiresAt,
            "recordingRetentionDays": getUserRecordingRetentionDays(userID),
            "defaultRecordingRetentionDays": normalizeRetentionDays(defaultRecordingRetentionDays),
            "maxRecordingRetentionDays": maxRecordingRetentionDays,
        },
    })

# Updates the user's journey recording retention duration and cleans up newly expired records
@app.route("/api/account/retention", methods=["POST"])
def updateAccountRetention():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    data = request.get_json(silent=True) or {}
    rawDays = data.get("recordingRetentionDays")
    try:
        days = int(rawDays)
    except (TypeError, ValueError):
        conn.close()
        return jsonify({"status": "error", "message": "Invalid retention period"}), 400

    if days not in allowedRetentionDays:
        conn.close()
        return jsonify({"status": "error", "message": "Unsupported retention period"}), 400

    if maxRecordingRetentionDays is not None and (days == 0 or days > maxRecordingRetentionDays):
        conn.close()
        return jsonify({
            "status": "error",
            "message": f"Server policy caps recording retention at {maxRecordingRetentionDays} days",
        }), 400

    configPath = os.path.join(configsDir, f"{userID}.json")
    config = readUserConfig(userID)
    if not config:
        config = {
            "userID": userID,
            "grid": {"cols": 5, "rows": 3},
            "theme": "default",
        }
    config["recordingRetentionDays"] = days
    config["updatedAt"] = datetime.now(timezone.utc).isoformat()
    with open(configPath, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)

    expiredPaths = pruneExpiredRecordings(cursor, userID=userID)
    conn.commit()
    cursor.execute("SELECT COUNT(*) FROM Recordings WHERE userID = ?", (userID,))
    remainingCount = cursor.fetchone()[0]
    conn.close()

    _safeRemoveRecordingFiles(expiredPaths)

    return jsonify({
        "status": "success",
        "message": "Recording retention policy updated",
        "recordingRetentionDays": days,
        "prunedCount": len(expiredPaths),
        "recordingCount": remainingCount,
    })

# Updates the authenticated user's profile username or password
@app.route("/api/account/profile", methods=["POST", "PATCH"])
def updateAccountProfile():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    data = request.get_json(silent=True) or {}
    newUsername = data.get("username")
    currentPassword = data.get("currentPassword") or ""
    newPassword = data.get("newPassword") or ""

    cursor.execute("SELECT username, passwordHash FROM Users WHERE userID = ?", (userID,))
    userRow = cursor.fetchone()
    if userRow is None:
        conn.close()
        return jsonify({"status": "error", "message": "User not found"}), 404

    currentUsername, passwordHash = userRow
    updatedFields = []

    if newUsername is not None:
        cleanUsername = str(newUsername).strip()
        if len(cleanUsername) < 2 or len(cleanUsername) > 64:
            conn.close()
            return jsonify({"status": "error", "message": "Username must be between 2 and 64 characters"}), 400
        if cleanUsername != currentUsername:
            cursor.execute("SELECT userID FROM Users WHERE username = ? AND userID != ?", (cleanUsername, userID))
            if cursor.fetchone() is not None:
                conn.close()
                return jsonify({"status": "error", "message": "That username is already taken"}), 409
            cursor.execute("UPDATE Users SET username = ? WHERE userID = ?", (cleanUsername, userID))
            currentUsername = cleanUsername
            updatedFields.append("username")

    if newPassword:
        if not currentPassword or not check_password_hash(passwordHash, currentPassword):
            conn.close()
            return jsonify({"status": "error", "message": "Current password is incorrect"}), 403
        if len(newPassword) < 8:
            conn.close()
            return jsonify({"status": "error", "message": "New password must be at least 8 characters"}), 400
        cursor.execute(
            "UPDATE Users SET passwordHash = ? WHERE userID = ?",
            (generate_password_hash(newPassword), userID),
        )
        token = getBearerToken()
        if token:
            cursor.execute(
                "DELETE FROM Sessions WHERE userID = ? AND tokenHash != ?",
                (userID, hashToken(token)),
            )
        updatedFields.append("password")

    if not updatedFields:
        conn.close()
        return jsonify({"status": "error", "message": "No profile changes were provided"}), 400

    conn.commit()
    conn.close()
    return jsonify({
        "status": "success",
        "message": "Account updated (" + ", ".join(updatedFields) + ")",
        "username": currentUsername,
    })

# Exports all account data including connections, recordings and settings as ZIP or JSON
@app.route("/api/account/export", methods=["GET"])
def exportAccountData():
    conn = sqlite3.connect(dbPath)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    cursor.execute("SELECT userID, username FROM Users WHERE userID = ?", (userID,))
    userRow = cursor.fetchone()
    if userRow is None:
        conn.close()
        return jsonify({"status": "error", "message": "User not found"}), 404

    cursor.execute(
        "SELECT connectionID, ipAddress, apiKey FROM Connections WHERE userID = ? ORDER BY connectionID ASC",
        (userID,),
    )
    connections = [
        {
            "connectionID": r["connectionID"],
            "ipAddress": _safeDecrypt(r["ipAddress"]),
            "apiKey": _safeDecrypt(r["apiKey"]),
        }
        for r in cursor.fetchall()
    ]

    cursor.execute(
        """
        SELECT recordingID, title, filePath, startedAt, endedAt, simStartTime, simEndTime,
               durationSec, sampleCount, trainName, routeID, routeName, direction,
               originStation, destinationStation, terminusStation, distanceMiles,
               topSpeedMph, avgSpeedMph, peakAccel, peakBrake, overspeedCount, fileSizeBytes
        FROM Recordings
        WHERE userID = ?
        ORDER BY startedAt DESC
        """,
        (userID,),
    )
    recordingRows = [dict(r) for r in cursor.fetchall()]

    contactRows = []
    try:
        cursor.execute(
            """
            SELECT referenceID, category, senderName, replyTo, subject, message, createdAt
            FROM ContactMessages
            WHERE userID = ?
            ORDER BY createdAt DESC
            """,
            (userID,),
        )
        contactRows = [dict(r) for r in cursor.fetchall()]
    except sqlite3.OperationalError:
        contactRows = []
    conn.close()

    dashboardConfig = None
    configPath = os.path.join(configsDir, f"{userID}.json")
    if os.path.exists(configPath):
        try:
            with open(configPath, "r", encoding="utf-8") as f:
                dashboardConfig = json.load(f)
        except Exception:
            dashboardConfig = None

    exportManifest = {
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "account": {
            "userID": userRow["userID"],
            "username": userRow["username"],
        },
        "connections": connections,
        "dashboardConfig": dashboardConfig,
        "recordings": [
            {k: v for k, v in rec.items() if k != "filePath"}
            for rec in recordingRows
        ],
        "contactEnquiries": contactRows,
    }

    safeName = re.sub(r"[^A-Za-z0-9_-]+", "_", userRow["username"]).strip("_") or f"user_{userID}"
    if request.args.get("format") == "json":
        return Response(
            json.dumps(exportManifest, indent=2),
            mimetype="application/json",
            headers={"Content-Disposition": f'attachment; filename="TSW6_Account_Export_{safeName}.json"'},
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("account.json", json.dumps(exportManifest, indent=2))
        if dashboardConfig is not None:
            zf.writestr("dashboard_config.json", json.dumps(dashboardConfig, indent=2))
        for rec in recordingRows:
            relPath = rec.get("filePath")
            if not relPath:
                continue
            absPath = os.path.join(recordingsDir, relPath)
            if os.path.exists(absPath):
                try:
                    archive = recEngine.loadRecordingArchive(absPath)
                    zf.writestr(f"recordings/{rec['recordingID']}.json", json.dumps(archive, indent=2))
                except Exception:
                    pass

    buf.seek(0)
    return Response(
        buf.getvalue(),
        mimetype="application/zip",
        headers={"Content-Disposition": f'attachment; filename="TSW6_Account_Export_{safeName}.zip"'},
    )

# Permanently deletes a user account, connections, recordings, files, and stored configurations
@app.route("/api/account", methods=["DELETE"])
def deleteAccount():
    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    if userID is None:
        conn.close()
        return jsonify({"status": "error", "message": "Not authenticated"}), 401

    data = request.get_json(silent=True) or {}
    password = data.get("password") or ""

    cursor.execute("SELECT passwordHash FROM Users WHERE userID = ?", (userID,))
    userRow = cursor.fetchone()
    if userRow is None:
        conn.close()
        return jsonify({"status": "error", "message": "User not found"}), 404

    if not password or not check_password_hash(userRow[0], password):
        conn.close()
        return jsonify({"status": "error", "message": "Password verification failed"}), 403

    cursor.execute("SELECT filePath FROM Recordings WHERE userID = ?", (userID,))
    recPaths = [r[0] for r in cursor.fetchall() if r[0]]

    cursor.execute("DELETE FROM Recordings WHERE userID = ?", (userID,))
    cursor.execute("DELETE FROM Connections WHERE userID = ?", (userID,))
    cursor.execute("DELETE FROM Sessions WHERE userID = ?", (userID,))
    cursor.execute("DELETE FROM ContactMessages WHERE userID = ?", (userID,))
    cursor.execute("DELETE FROM Users WHERE userID = ?", (userID,))
    conn.commit()
    conn.close()

    for relPath in recPaths:
        absPath = os.path.join(recordingsDir, relPath)
        if os.path.exists(absPath):
            try:
                os.remove(absPath)
            except OSError:
                pass

    userRecDir = os.path.join(recordingsDir, str(userID))
    if os.path.isdir(userRecDir):
        try:
            shutil.rmtree(userRecDir)
        except OSError:
            pass

    cfgFile = os.path.join(configsDir, f"{userID}.json")
    if os.path.exists(cfgFile):
        try:
            os.remove(cfgFile)
        except OSError:
            pass

    return jsonify({"status": "success", "message": "Account and all associated data deleted"})

# Submits a new user enquiry, saves it to the database, and dispatches a Discord notification
@app.route("/api/contact", methods=["POST"])
def submitContactEnquiry():
    if _isRateLimited("contact_submit", maxHits=5, windowSec=600):
        return jsonify({
            "status": "error",
            "message": "Too many enquiries sent recently. Please wait a few minutes before sending another.",
        }), 429

    data = request.get_json(silent=True) or {}
    category = str(data.get("category") or "support").strip().lower()
    if category not in contactCategories:
        return jsonify({"status": "error", "message": "Invalid enquiry topic"}), 400

    senderName = str(data.get("name") or "").strip()[:80]
    replyTo = str(data.get("replyTo") or "").strip()[:160]
    subject = str(data.get("subject") or "").strip()
    message = str(data.get("message") or "").strip()

    if len(subject) < 3 or len(subject) > 120:
        return jsonify({"status": "error", "message": "Subject must be between 3 and 120 characters"}), 400
    if len(message) < 10 or len(message) > 3000:
        return jsonify({"status": "error", "message": "Message must be between 10 and 3000 characters"}), 400
    if replyTo and not emailRegex.match(replyTo):
        return jsonify({"status": "error", "message": "Please enter a valid reply email address"}), 400

    nowDT = datetime.now(timezone.utc)
    refID = f"TSW-{nowDT.strftime('%Y%m%d')}-{secrets.token_hex(3).upper()}"

    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    userID = getSessionUserID(cursor)
    accountUsername = None
    if userID is not None:
        cursor.execute("SELECT username FROM Users WHERE userID = ?", (userID,))
        uRow = cursor.fetchone()
        if uRow:
            accountUsername = f"{uRow[0]} (#{userID})"

    cursor.execute(
        """
        INSERT INTO ContactMessages (referenceID, userID, category, senderName, replyTo, subject, message, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (refID, userID, category, senderName, replyTo, subject, message, nowDT.isoformat()),
    )
    conn.commit()
    conn.close()

    dispatchContactDiscordWebhook(
        refID,
        category,
        senderName,
        replyTo,
        subject,
        message,
        accountUsername=accountUsername,
        createdAt=nowDT,
    )
    _recordRateHit("contact_submit", windowSec=600)

    return jsonify({
        "status": "success",
        "referenceId": refID,
        "message": "Enquiry submitted successfully",
    }), 201

# Registers a new user account with hashed password and terms acceptance verification
@app.route("/register", methods=["POST"])
def register():
    if _isRateLimited("register_attempt", maxHits=5, windowSec=600):
        return jsonify({
            "status": "error",
            "message": "Too many registration attempts. Please wait a few minutes before trying again.",
        }), 429

    data = request.get_json(silent=True) or {}
    username = str(data.get("username") or "").strip()
    password = str(data.get("password") or "")
    acceptLegal = bool(data.get("acceptLegal", False))

    if len(username) < 2 or len(username) > 64:
        return jsonify({"status": "error", "message": "Username must be between 2 and 64 characters"}), 400
    if len(password) < 8 or len(password) > 256:
        return jsonify({"status": "error", "message": "Password must be between 8 and 256 characters"}), 400
    if not acceptLegal:
        return jsonify({"status": "error", "message": "Please accept the Terms of Service and Privacy Policy"}), 400

    conn = sqlite3.connect(dbPath)
    cursor = conn.cursor()
    cursor.execute("SELECT userID FROM Users WHERE username = ?", (username,))
    user = cursor.fetchone()
    if user is not None:
        conn.close()
        return jsonify({"status": "error", "message": "Username already exists"}), 409

    try:
        cursor.execute("INSERT INTO Users (username, passwordHash) VALUES (?, ?)", (username, generate_password_hash(password)))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({"status": "error", "message": "Username already exists"}), 409
    conn.close()

    _recordRateHit("register_attempt", windowSec=600)
    return jsonify({"status": "success", "message": "Registration successful"})

# Custom WSGI request handler that anonymises client IP addresses in web server access logs
class PrivacyRequestHandler(WSGIRequestHandler):

    def address_string(self):
        if logClientIPs:
            return super().address_string()
        return "redacted"


if __name__ == "__main__":
    host = os.environ.get("TSW6_HOST", "0.0.0.0")
    port = int(os.environ.get("TSW6_PORT", "8018"))
    debugMode = os.environ.get("TSW6_DEBUG", "").lower() in ("1", "true", "yes")
    sslCert = os.environ.get("TSW6_SSL_CERT")
    sslKey = os.environ.get("TSW6_SSL_KEY")
    sslContext = (sslCert, sslKey) if (sslCert and sslKey) else None
    app.run(
        host=host,
        port=port,
        debug=debugMode,
        ssl_context=sslContext,
        request_handler=PrivacyRequestHandler,
    )
