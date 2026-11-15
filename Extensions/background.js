const extApi = typeof browser !== "undefined" ? browser : chrome;

const ALLOWED_METHODS = new Set(["GET", "PATCH"]);
const ALLOWED_PATH_PREFIXES = ["/get/", "/set/", "/list", "/info"];
const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal"]);

function validateTargetUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(String(rawUrl || ""));
    } catch (_err) {
        return { error: "Invalid target URL" };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { error: "Unsupported protocol" };
    }

    const hostLower = parsed.hostname.toLowerCase();
    if (!hostLower || BLOCKED_HOSTS.has(hostLower) || hostLower.startsWith("169.254.")) {
        return { error: "Blocked target host" };
    }

    const hasAllowedPath = ALLOWED_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix));
    if (!hasAllowedPath) {
        return { error: "Disallowed TSW6 API endpoint path" };
    }

    return { url: parsed.toString() };
}

function pickAllowedHeaders(rawHeaders) {
    const out = {};
    if (!rawHeaders || typeof rawHeaders !== "object") {
        return out;
    }
    for (const [key, value] of Object.entries(rawHeaders)) {
        if (key.toLowerCase() === "dtgcommkey" && typeof value === "string" && value.trim()) {
            out.DTGCommKey = value.trim();
        }
    }
    return out;
}

async function handleTsw6Fetch(msg) {
    const method = String(msg.method || "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
        return { ok: false, status: 0, error: "Unsupported HTTP method" };
    }

    const checked = validateTargetUrl(msg.url);
    if (checked.error) {
        return { ok: false, status: 0, error: checked.error };
    }

    const timeoutMs = Math.min(Math.max(Number(msg.timeoutMs) || 1000, 100), 15000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(checked.url, {
            method,
            headers: pickAllowedHeaders(msg.headers),
            signal: controller.signal
        });

        let data = null;
        const text = await response.text();
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (_parseErr) {
                data = { raw: text };
            }
        }

        return {
            ok: true,
            status: response.status,
            data
        };
    } catch (err) {
        console.error("[TSW6-Ext] Fetch failed for:", checked.url, "Method:", method, "Error:", err);
        return {
            ok: false,
            status: 0,
            error: (err && err.name === "AbortError")
                ? "Request to TSW6 timed out"
                : ((err && err.message) || "Failed to reach local TSW6 API")
        };
    } finally {
        clearTimeout(timer);
    }
}

extApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "TSW6_FETCH") {
        return false;
    }

    if (sender.id !== extApi.runtime.id || !sender.tab) {
        sendResponse({ ok: false, status: 0, error: "Unauthorized sender" });
        return false;
    }

    handleTsw6Fetch(msg)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({
            ok: false,
            status: 0,
            error: (err && err.message) || "Unexpected connector error"
        }));

    return true;
});

