/* Here lies the JavaScript concerned with telemetry interface layouts */
/* This will handle the theme management, session verification, recording engine, live header telemetry polling, and seamless view switching */
/* Remember consistency is key */

(function () {
    /* This checks whether the user is on a mobile device or tablet to politely redirect them away */
    function isMobileDevice() {
        const ua = navigator.userAgent || navigator.vendor || window.opera || "";
        if (/iPhone|iPod|iPad/i.test(ua)) return true;
        if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
        if (/Android/i.test(ua)) return true;
        if (/windows phone|iemobile|mobile|tablet|silk|kindle/i.test(ua)) return true;
        if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches && (navigator.maxTouchPoints > 1) && window.innerWidth <= 1024) {
            return true;
        }
        return false;
    }

    /* Immediate redirect for mobile devices since telemetry interface requires desktop browser extension support */
    if (isMobileDevice()) {
        window.location.replace("/connect?from_telem=1");
        return;
    }

    /* Here we set up our local storage keys, session keys, and telemetry polling intervals */
    const TOKEN_KEY = "tsw6ti_session_token";
    const RECORDING_KEY = "tsw6ti_is_recording";
    const TELEM_STATE_KEY = "tsw6ti_telemetry_state";
    const THEME_KEY = "tsw6ti_theme";
    const ACCENT_KEY = "tsw6ti_accent_color";
    const HEADER_POLL_MS = 1000;

    /* These are the valid themes supported by the telemetry interface */
    const VALID_THEMES = [
        "default",
        "light",
        "dark",
        "oled",
        "gruvbox",
        "solarized-light",
        "solarized-dark",
        "dracula",
        "nord",
        "catppuccin-latte",
        "catppuccin-frappe",
        "catppuccin-macchiato",
        "catppuccin-mocha",
        "follow-train"
    ];

    /* Themes that support custom accent color picker customization */
    const ACCENT_THEMES = ["light", "dark", "oled"];
    const DEFAULT_ACCENT_BY_THEME = {
        light: "#3b82f6",
        dark: "#38bdf8",
        oled: "#34d399"
    };

    /* The CSS custom property variable names updated when custom accent colors are chosen */
    const ACCENT_VAR_NAMES = [
        "--accent-primary",
        "--accent-bright",
        "--accent-deep",
        "--accent-soft",
        "--accent-contrast",
        "--accent-glow",
        "--accent-subtle",
        "--border-purple",
        "--border-purple-strong",
        "--telem-card-hover-border"
    ];

    /* Internal states for recording, polling timers, and train theme detection */
    let isRecording = sessionStorage.getItem(RECORDING_KEY) === "true";
    let pollTimer = null;
    let lastDetectedTrainTheme = "default";

    /* Helper that formats the Authorization Bearer header for authenticated requests */
    function authHeader(token) {
        return { Authorization: "Bearer " + token };
    }

    /* Detects the locomotive or train livery from the game to dynamically pick a train-specific theme */
    function detectTrainTheme(trainName) {
        if (!trainName || trainName === "Unknown" || trainName === "N/A") {
            return "default";
        }
        const t = String(trainName).toLowerCase();
        if (t.includes("thomas") || t.includes("annie") || t.includes("clarabel") || t.includes("sodor")) {
            return "thomas";
        }
        if (
            t.includes("grn") ||
            t.includes("green") ||
            t.includes("giant") ||
            t.includes("wsr") ||
            t.includes("class 09") ||
            t.includes("09") ||
            t.includes("class 47") ||
            t.includes("class 33") ||
            t.includes("class 52")
        ) {
            return "grn";
        }
        if (t.includes("disel") || t.includes("diesel") || t.includes("class 08") || t.includes("shunter")) {
            return "diesel";
        }
        if (
            t.includes("gwr") ||
            t.includes("great western") ||
            t.includes("hst") ||
            t.includes("class 43") ||
            t.includes("class 166") ||
            t.includes("class 800") ||
            t.includes("class 802") ||
            t.includes("iet")
        ) {
            return "gwr";
        }
        if (
            t.includes("220") ||
            t.includes("221") ||
            t.includes("xc") ||
            t.includes("voyager") ||
            t.includes("crosscountry") ||
            t.includes("cross country")
        ) {
            return "xc";
        }
        if (
            t.includes("tfw") ||
            t.includes("wales") ||
            t.includes("cymru") ||
            t.includes("class 150") ||
            t.includes("class 153") ||
            t.includes("class 175") ||
            t.includes("class 231") ||
            t.includes("class 756")
        ) {
            return "tfw";
        }
        return "default";
    }

    /* Normalizes a 6-digit hex color code string */
    function normalizeHex(hex) {
        if (typeof hex !== "string") return null;
        const clean = hex.trim().toLowerCase();
        return /^#[0-9a-f]{6}$/.test(clean) ? clean : null;
    }

    /* Converts a hex color string into an RGB numeric object */
    function hexToRgb(hex) {
        const clean = normalizeHex(hex) || "#3b82f6";
        return {
            r: parseInt(clean.slice(1, 3), 16),
            g: parseInt(clean.slice(3, 5), 16),
            b: parseInt(clean.slice(5, 7), 16)
        };
    }

    /* Mixes two RGB colors together based on a decimal ratio between 0 and 1 */
    function mixRgb(c1, c2, ratio) {
        const clamp = function (v) { return Math.max(0, Math.min(255, Math.round(v))); };
        const toHex = function (v) { return clamp(v).toString(16).padStart(2, "0"); };
        return "#" +
            toHex(c1.r + (c2.r - c1.r) * ratio) +
            toHex(c1.g + (c2.g - c1.g) * ratio) +
            toHex(c1.b + (c2.b - c1.b) * ratio);
    }

    /* Clears all custom accent color overrides from the telemetry layout */
    function clearAccentOverrides(layoutEl) {
        if (!layoutEl) return;
        ACCENT_VAR_NAMES.forEach(function (name) {
            layoutEl.style.removeProperty(name);
        });
    }

    /* Dynamically calculates and applies accent color CSS custom properties to the layout */
    function applyAccentOverrides(themeId, hexColor) {
        const layoutEl = document.querySelector(".telem-layout");
        if (!layoutEl) return;

        if (!ACCENT_THEMES.includes(themeId)) {
            clearAccentOverrides(layoutEl);
            return;
        }

        const resolvedHex = normalizeHex(hexColor) || normalizeHex(localStorage.getItem(ACCENT_KEY)) || DEFAULT_ACCENT_BY_THEME[themeId] || "#3b82f6";
        const rgb = hexToRgb(resolvedHex);
        const isLight = themeId === "light";
        const deepHex = mixRgb(rgb, { r: 0, g: 0, b: 0 }, 0.24);
        const primaryHex = isLight ? mixRgb(rgb, { r: 0, g: 0, b: 0 }, 0.14) : resolvedHex;
        const softHex = isLight
            ? mixRgb(rgb, { r: 0, g: 0, b: 0 }, 0.18)
            : mixRgb(rgb, { r: 255, g: 255, b: 255 }, 0.34);

        const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
        const contrastHex = luminance > 0.68 ? "#0f172a" : "#ffffff";

        layoutEl.style.setProperty("--accent-primary", primaryHex);
        layoutEl.style.setProperty("--accent-bright", resolvedHex);
        layoutEl.style.setProperty("--accent-deep", deepHex);
        layoutEl.style.setProperty("--accent-soft", softHex);
        layoutEl.style.setProperty("--accent-contrast", contrastHex);
        layoutEl.style.setProperty("--accent-glow", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isLight ? 0.25 : 0.35})`);
        layoutEl.style.setProperty("--accent-subtle", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isLight ? 0.11 : 0.15})`);
        layoutEl.style.setProperty("--border-purple", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.36)`);
        layoutEl.style.setProperty("--border-purple-strong", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.64)`);
        layoutEl.style.setProperty("--telem-card-hover-border", `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5)`);
    }

    /* Applies the chosen theme stylesheet, updates data-theme attributes, and emits a custom theme event */
    function applyTheme(themeId, accentOverride) {
        const activeTheme = VALID_THEMES.includes(themeId) ? themeId : "default";
        localStorage.setItem(THEME_KEY, activeTheme);

        const validAccent = normalizeHex(accentOverride);
        if (validAccent) {
            localStorage.setItem(ACCENT_KEY, validAccent);
        }

        const layoutEl = document.querySelector(".telem-layout");
        if (layoutEl) {
            layoutEl.setAttribute("data-theme", activeTheme);
            if (activeTheme === "follow-train") {
                layoutEl.setAttribute("data-train-theme", lastDetectedTrainTheme || "default");
            } else {
                layoutEl.removeAttribute("data-train-theme");
            }
        }

        applyAccentOverrides(activeTheme, validAccent);

        const emitThemeEvent = function () {
            window.dispatchEvent(new CustomEvent("tsw6:theme", {
                detail: {
                    theme: activeTheme,
                    accentColor: getCurrentAccentColor(activeTheme)
                }
            }));
        };

        const linkEl = document.getElementById("telem-theme-stylesheet");
        const targetHref = `/Client/CSS/Themes/${encodeURIComponent(activeTheme)}.css`;
        if (linkEl) {
            if (!linkEl.getAttribute("href") || !linkEl.getAttribute("href").endsWith(`/${activeTheme}.css`)) {
                linkEl.onload = function () {
                    applyAccentOverrides(activeTheme, validAccent);
                    emitThemeEvent();
                };
                linkEl.setAttribute("href", targetHref);
            } else {
                emitThemeEvent();
            }
        }
    }

    /* Gets the currently active theme from local storage with a fallback to default */
    function getCurrentTheme() {
        const saved = localStorage.getItem(THEME_KEY);
        return VALID_THEMES.includes(saved) ? saved : "default";
    }

    /* Gets the current accent color for the theme or defaults */
    function getCurrentAccentColor(themeId) {
        const t = themeId || getCurrentTheme();
        return normalizeHex(localStorage.getItem(ACCENT_KEY)) || DEFAULT_ACCENT_BY_THEME[t] || "#3b82f6";
    }

    /* Updates and persists a new accent color and broadcasts the change to all telemetry modules */
    function setAccentColor(hexColor) {
        const validHex = normalizeHex(hexColor);
        if (!validHex) return;
        localStorage.setItem(ACCENT_KEY, validHex);
        const activeTheme = getCurrentTheme();
        applyAccentOverrides(activeTheme, validHex);
        window.dispatchEvent(new CustomEvent("tsw6:theme", {
            detail: { theme: activeTheme, accentColor: validHex }
        }));
    }

    /* Saves the user's theme and accent color preference to the database */
    async function saveThemeConfig(themeId, accentColor) {
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) return false;
        const body = {};
        if (themeId) body.theme = themeId;
        const validHex = normalizeHex(accentColor);
        if (validHex) body.accentColor = validHex;
        try {
            const response = await fetch("/api/dashboard-config", {
                method: "POST",
                headers: Object.assign({ "Content-Type": "application/json" }, authHeader(token)),
                body: JSON.stringify(body)
            });
            return response.ok;
        } catch (err) {
            return false;
        }
    }

    /* Public theme manager API exposed on window for settings and dashboard modules to consume */
    window.TSWTheme = {
        apply: applyTheme,
        setAccentColor: setAccentColor,
        getAccentColor: getCurrentAccentColor,
        supportsAccent: function (themeId) {
            return ACCENT_THEMES.includes(themeId || getCurrentTheme());
        },
        saveToConfig: saveThemeConfig,
        getCurrent: getCurrentTheme,
        VALID_THEMES: VALID_THEMES,
        ACCENT_THEMES: ACCENT_THEMES
    };

    /* Verifies the user's session token against the backend; redirects to /auth if missing or expired */
    async function verifySession() {
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) {
            window.location.href = "/auth";
            return null;
        }
        try {
            const response = await fetch("/session", { headers: authHeader(token) });
            if (response.ok) {
                const data = await response.json();
                return data.username;
            }
            if (response.status === 401) {
                localStorage.removeItem(TOKEN_KEY);
                window.location.href = "/auth";
                return null;
            }
        } catch (err) {
        }
        return null;
    }

    /* Handles logging out ensuring it clears session tokens, active game connections, and IndexedDB recording data */
    async function handleLogout() {
        const token = localStorage.getItem(TOKEN_KEY);
        [
            TOKEN_KEY,
            "tsw6ti_active_connection",
            THEME_KEY,
            ACCENT_KEY,
            "tsw6ti_speed_unit"
        ].forEach(function (k) {
            try { localStorage.removeItem(k); } catch (err) { }
        });
        sessionStorage.removeItem(RECORDING_KEY);
        sessionStorage.removeItem(REC_START_KEY);
        sessionStorage.removeItem(TELEM_STATE_KEY);
        await clearRecorderDb();
        if (window.indexedDB) {
            try {
                await new Promise(function (resolve) {
                    if (recDbPromise) {
                        recDbPromise.then(function (db) {
                            if (db) { try { db.close(); } catch (e) { } }
                            const req = window.indexedDB.deleteDatabase("tsw6ti_recorder_v1");
                            req.onsuccess = resolve;
                            req.onerror = resolve;
                            req.onblocked = resolve;
                        });
                    } else {
                        const req = window.indexedDB.deleteDatabase("tsw6ti_recorder_v1");
                        req.onsuccess = resolve;
                        req.onerror = resolve;
                        req.onblocked = resolve;
                    }
                });
            } catch (err) {
            }
        }
        if (window.TSW6 && typeof window.TSW6.clearActiveConnection === "function") {
            window.TSW6.clearActiveConnection();
        }
        if (token) {
            try {
                await fetch("/logout", { method: "POST", headers: authHeader(token) });
            } catch (err) {
            }
        }
        window.location.href = "/";
    }

    /* Keys and variables for local recording storage */
    const REC_START_KEY = "tsw6ti_recording_started_at";
    let recordingStartedAt = sessionStorage.getItem(REC_START_KEY) || "";
    let memorySamples = [];
    let isSavingRecording = false;
    let recDbPromise = null;
    let globalToastTimer = null;

    /* Opens or creates the IndexedDB database for holding high-frequency telemetry recording samples */
    function openRecorderDb() {
        if (recDbPromise) return recDbPromise;
        if (!window.indexedDB) return Promise.resolve(null);
        recDbPromise = new Promise(function (resolve) {
            try {
                const req = window.indexedDB.open("tsw6ti_recorder_v1", 1);
                req.onupgradeneeded = function (e) {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains("samples")) {
                        db.createObjectStore("samples", { autoIncrement: true });
                    }
                };
                req.onsuccess = function (e) { resolve(e.target.result); };
                req.onerror = function () { resolve(null); };
            } catch (err) {
                resolve(null);
            }
        });
        return recDbPromise;
    }

    /* Clears all recorded telemetry samples from memory and IndexedDB */
    async function clearRecorderDb() {
        memorySamples = [];
        const db = await openRecorderDb();
        if (!db) return;
        await new Promise(function (resolve) {
            try {
                const tx = db.transaction("samples", "readwrite");
                tx.objectStore("samples").clear();
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            } catch (err) {
                resolve();
            }
        });
    }

    /* Appends a new telemetry sample frame into IndexedDB with an in-memory fallback */
    async function appendSampleToDb(sample) {
        memorySamples.push(sample);
        const db = await openRecorderDb();
        if (!db) return;
        try {
            const tx = db.transaction("samples", "readwrite");
            tx.objectStore("samples").add(sample);
        } catch (err) {
            /* Keep in-memory fallback */
        }
    }

    /* Retrieves all recorded telemetry sample frames from IndexedDB */
    async function getAllRecordedSamples() {
        const db = await openRecorderDb();
        if (!db) return memorySamples.slice();
        const rows = await new Promise(function (resolve) {
            try {
                const tx = db.transaction("samples", "readonly");
                const req = tx.objectStore("samples").getAll();
                req.onsuccess = function () { resolve(Array.isArray(req.result) ? req.result : []); };
                req.onerror = function () { resolve(memorySamples.slice()); };
            } catch (err) {
                resolve(memorySamples.slice());
            }
        });
        return rows.length >= memorySamples.length ? rows : memorySamples.slice();
    }

    /* Displays a global alert notification banner in the telemetry interface */
    function showGlobalToast(message, linkHref, isError) {
        const toast = document.getElementById("telem-global-toast");
        const msgEl = document.getElementById("telem-global-toast-msg");
        const linkEl = document.getElementById("telem-global-toast-link");
        const iconEl = document.getElementById("telem-global-toast-icon");
        if (!toast || !msgEl) return;

        msgEl.textContent = message;
        toast.classList.toggle("is-error", Boolean(isError));
        if (iconEl) {
            iconEl.className = isError ? "fa-solid fa-triangle-exclamation" : "fa-solid fa-circle-check";
        }
        if (linkEl) {
            if (linkHref) {
                linkEl.href = linkHref;
                linkEl.hidden = false;
            } else {
                linkEl.hidden = true;
            }
        }
        toast.hidden = false;
        if (globalToastTimer) clearTimeout(globalToastTimer);
        globalToastTimer = setTimeout(function () {
            toast.hidden = true;
        }, 6000);
    }

    /* Global alert helper exposed on window */
    window.TSWToast = { show: showGlobalToast };

    /* Public recording API exposed on window for telemetry modules to push live driving samples */
    window.TSWRecorder = {
        isRecording: function () {
            return isRecording;
        },
        recordSample: function (sample) {
            if (!isRecording || !sample) return;
            appendSampleToDb(sample);
        }
    };

    /* Sets up the recording control UI buttons and runtime timer in the header */
    function setupRecordingControls() {
        const label = document.getElementById("telem-record-label");
        const timerEl = document.getElementById("telem-record-timer");
        const startBtn = document.getElementById("telem-record-start");
        const stopBtn = document.getElementById("telem-record-stop");

        if (!startBtn || !stopBtn || !label) return;

        let runtimeInterval = null;

        /* Formats elapsed milliseconds into HH:MM:SS or MM:SS */
        function formatRuntime(elapsedMs) {
            const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
            const h = Math.floor(totalSec / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            const s = totalSec % 60;
            const mm = String(m).padStart(2, "0");
            const ss = String(s).padStart(2, "0");
            return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
        }

        /* Refreshes the active recording timer display */
        function refreshTimerText() {
            if (!timerEl) return;
            if (!isRecording) {
                timerEl.hidden = true;
                timerEl.textContent = "00:00";
                return;
            }
            const startMs = recordingStartedAt ? Date.parse(recordingStartedAt) : NaN;
            const elapsedMs = Number.isFinite(startMs) ? Math.max(0, Date.now() - startMs) : 0;
            timerEl.textContent = formatRuntime(elapsedMs);
            timerEl.hidden = false;
        }

        /* Keeps the recording runtime counter ticking every 500ms while recording is active */
        function syncRuntimeInterval() {
            if (runtimeInterval) {
                clearInterval(runtimeInterval);
                runtimeInterval = null;
            }
            refreshTimerText();
            if (isRecording) {
                runtimeInterval = setInterval(refreshTimerText, 500);
            }
        }

        /* Updates the recording UI buttons and badges based on whether recording is active or saving */
        function updateRecordingUI() {
            if (isSavingRecording) {
                label.textContent = "SAVING...";
                label.classList.remove("is-recording");
                if (timerEl) timerEl.hidden = true;
                startBtn.disabled = true;
                stopBtn.disabled = true;
                if (runtimeInterval) {
                    clearInterval(runtimeInterval);
                    runtimeInterval = null;
                }
                return;
            }
            label.textContent = isRecording ? "RECORDING" : "NOT RECORDING";
            label.classList.toggle("is-recording", isRecording);
            startBtn.classList.toggle("is-active", isRecording);
            startBtn.disabled = isRecording;
            stopBtn.disabled = !isRecording;
            syncRuntimeInterval();
        }

        /* When the user clicks the record start button, initialize a new recording session */
        startBtn.addEventListener("click", async function () {
            if (isRecording || isSavingRecording) return;
            await clearRecorderDb();
            isRecording = true;
            recordingStartedAt = new Date().toISOString();
            sessionStorage.setItem(RECORDING_KEY, "true");
            sessionStorage.setItem(REC_START_KEY, recordingStartedAt);
            updateRecordingUI();
            window.dispatchEvent(new CustomEvent("tsw6:recording", { detail: { recording: true } }));
        });

        /* When the user clicks the record stop button, package up samples and upload to the server */
        stopBtn.addEventListener("click", async function () {
            if (!isRecording || isSavingRecording) return;
            isRecording = false;
            isSavingRecording = true;
            sessionStorage.setItem(RECORDING_KEY, "false");
            updateRecordingUI();
            window.dispatchEvent(new CustomEvent("tsw6:recording", { detail: { recording: false } }));

            try {
                const samples = await getAllRecordedSamples();
                if (!samples || samples.length === 0) {
                    showGlobalToast("No telemetry frames captured during recording.", null, true);
                } else {
                    const token = localStorage.getItem(TOKEN_KEY);
                    const response = await fetch("/api/recordings", {
                        method: "POST",
                        headers: Object.assign({ "Content-Type": "application/json" }, authHeader(token)),
                        body: JSON.stringify({
                            startedAt: recordingStartedAt || new Date().toISOString(),
                            endedAt: new Date().toISOString(),
                            samples: samples
                        })
                    });
                    const data = await response.json();
                    if (response.ok && data.status === "success" && data.recording) {
                        const rec = data.recording;
                        showGlobalToast(
                            `Saved recording: ${rec.originStation} → ${rec.destinationStation}`,
                            `/recordings?id=${encodeURIComponent(rec.recordingID)}`,
                            false
                        );
                        window.dispatchEvent(new CustomEvent("tsw6:recording-saved", { detail: { recording: rec } }));
                    } else {
                        showGlobalToast(data.message || "Failed to save recording.", null, true);
                    }
                }
            } catch (err) {
                showGlobalToast("Error saving recording to server.", null, true);
            } finally {
                await clearRecorderDb();
                recordingStartedAt = "";
                sessionStorage.removeItem(REC_START_KEY);
                isSavingRecording = false;
                updateRecordingUI();
            }
        });

        updateRecordingUI();
    }

    /* Closes the header menu dropdown when clicking away or selecting an option */
    function closeMenuDropdown() {
        const menuBtn = document.getElementById("telem-menu-btn");
        const dropdown = document.getElementById("telem-menu-dropdown");
        if (dropdown && !dropdown.hidden) {
            dropdown.hidden = true;
            if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
        }
    }

    /* Toggles and manages the header navigation menu dropdown */
    function setupMenuDropdown() {
        const menuBtn = document.getElementById("telem-menu-btn");
        const dropdown = document.getElementById("telem-menu-dropdown");
        if (!menuBtn || !dropdown) return;

        menuBtn.addEventListener("click", function (event) {
            event.stopPropagation();
            const isHidden = dropdown.hidden;
            dropdown.hidden = !isHidden;
            menuBtn.setAttribute("aria-expanded", String(isHidden));
        });

        document.addEventListener("click", function (event) {
            if (!dropdown.hidden && !dropdown.contains(event.target) && event.target !== menuBtn) {
                closeMenuDropdown();
            }
        });
    }

    /* Dynamically fetches and mounts telemetry views into the DOM so navigation is instant without page reloads */
    async function ensureViewMounted(elementId, fallbackSelector, fetchUrl) {
        let el = document.getElementById(elementId) || document.querySelector(fallbackSelector);
        if (el) return el;

        const workspace = document.getElementById("telem-workspace") || document.querySelector(".telem-workspace");
        if (!workspace) return null;

        try {
            const response = await fetch(fetchUrl);
            if (!response.ok) return null;
            const html = await response.text();
            const doc = new DOMParser().parseFromString(html, "text/html");
            const fetched = doc.getElementById(elementId) || doc.querySelector(fallbackSelector);
            if (fetched) {
                fetched.hidden = true;
                workspace.appendChild(fetched);
                return fetched;
            }
        } catch (err) {
        }
        return null;
    }

    /* Mounts the settings view */
    async function ensureSettingsViewMounted() {
        const el = await ensureViewMounted("settings-wrapper", ".settings-container", "/settings");
        if (el && window.TSWSettings && typeof window.TSWSettings.init === "function") {
            window.TSWSettings.init();
        }
        return el;
    }

    /* Mounts the recordings view */
    async function ensureRecordingsViewMounted() {
        const el = await ensureViewMounted("recordings-wrapper", ".recordings-container", "/recordings");
        if (el && window.TSWRecordings && typeof window.TSWRecordings.init === "function") {
            window.TSWRecordings.init();
        }
        return el;
    }

    /* Mounts the guides view */
    async function ensureGuidesViewMounted() {
        const el = await ensureViewMounted("guides-wrapper", ".guides-container", "/guides");
        return el;
    }

    /* Checks whether a pathname belongs to the guides section */
    function isGuidesPathname(pathname) {
        return pathname === "/guides" || pathname === "/guides.html" || pathname.startsWith("/guides/");
    }

    /* Smoothly switches between telemetry workspace views (dashboard, settings, recordings, guides) without full page reloads */
    async function switchTelemetryView(urlStr, pushHistory) {
        const url = new URL(urlStr, window.location.origin);
        const isSettings = url.pathname === "/settings" || url.pathname === "/settings.html";
        const isDashboard = url.pathname === "/dashboard" || url.pathname === "/dashboard.html";
        const isRecordings = url.pathname === "/recordings" || url.pathname === "/recordings.html";
        const isGuides = isGuidesPathname(url.pathname);

        if (!isSettings && !isDashboard && !isRecordings && !isGuides) {
            window.location.href = url.href;
            return;
        }

        if (pushHistory && (window.location.pathname + window.location.search) !== (url.pathname + url.search)) {
            window.history.pushState({}, "", url.pathname + url.search);
        }

        closeMenuDropdown();

        const dashEl = document.getElementById("dashboard-wrapper");
        const settingsEl = await ensureSettingsViewMounted();
        const recordingsEl = await ensureRecordingsViewMounted();
        const guidesEl = await ensureGuidesViewMounted();

        if (dashEl) dashEl.hidden = !isDashboard;
        if (settingsEl) settingsEl.hidden = !isSettings;
        if (recordingsEl) recordingsEl.hidden = !isRecordings;
        if (guidesEl) guidesEl.hidden = !isGuides;

        if (isSettings) {
            document.title = "TSW6 — Telemetry Settings";
            if (window.TSWSettings && typeof window.TSWSettings.init === "function") {
                window.TSWSettings.init();
            }
        } else if (isRecordings) {
            document.title = "TSW6 — Telemetry Recordings";
            const recId = url.searchParams.get("id");
            if (window.TSWRecordings && typeof window.TSWRecordings.onShow === "function") {
                window.TSWRecordings.onShow(recId);
            }
        } else if (isGuides) {
            document.title = "TSW6 — Guides";
            const guideSlug = url.searchParams.get("guide") || (url.pathname.startsWith("/guides/") ? decodeURIComponent(url.pathname.slice("/guides/".length)).replace(/\/+$/, "") : null);
            if (window.TSWGuides && typeof window.TSWGuides.onShow === "function") {
                window.TSWGuides.onShow(guideSlug);
            }
        } else if (isDashboard) {
            if (window.TSWDashboard && typeof window.TSWDashboard.ensureMounted === "function") {
                await window.TSWDashboard.ensureMounted();
            }
            const mountedDash = document.getElementById("dashboard-wrapper");
            if (mountedDash) mountedDash.hidden = false;
            if (settingsEl) settingsEl.hidden = true;
            if (recordingsEl) recordingsEl.hidden = true;
            if (guidesEl) guidesEl.hidden = true;
            document.title = "TSW6 — Live Telemetry";

            const editRequested = url.searchParams.get("edit") === "1";
            if (window.TSWDashboard && typeof window.TSWDashboard.onShow === "function") {
                window.TSWDashboard.onShow(editRequested);
            }
        }
    }

    /* Intercepts internal navigation links to enable seamless view switching */
    function setupSeamlessNavigation() {
        document.addEventListener("click", function (event) {
            const link = event.target.closest("a[href]");
            if (!link) return;
            if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
            }
            const href = link.getAttribute("href");
            if (!href) return;

            try {
                const url = new URL(href, window.location.origin);
                if (url.origin !== window.location.origin) return;
                if (
                    url.pathname === "/dashboard" ||
                    url.pathname === "/dashboard.html" ||
                    url.pathname === "/settings" ||
                    url.pathname === "/settings.html" ||
                    url.pathname === "/recordings" ||
                    url.pathname === "/recordings.html" ||
                    isGuidesPathname(url.pathname)
                ) {
                    event.preventDefault();
                    switchTelemetryView(url.href, true);
                }
            } catch (err) {
            }
        });

        window.addEventListener("popstate", function () {
            switchTelemetryView(window.location.href, false);
        });
    }

    /* Periodically polls TSW6 for the current train name and in-game time to update the header */
    async function updateHeaderTelemetry() {
        if (!window.TSW6) return;

        const trainEl = document.getElementById("telem-train-name");
        const simTimeEl = document.getElementById("telem-sim-time");
        const streamDot = document.getElementById("telem-stream-dot");

        try {
            const [trainName, dateTime] = await Promise.all([
                window.TSW6.getTrainName(),
                window.TSW6.getCurrentDateTime()
            ]);

            const isLive = Boolean(dateTime && !dateTime.startsWith("N/A"));

            if (streamDot) {
                streamDot.classList.toggle("is-live", isLive);
            }

            const resolvedTrain = trainName && trainName !== "N/A" ? trainName : "Unknown";
            if (trainEl) {
                trainEl.textContent = resolvedTrain;
            }

            const detectedTheme = detectTrainTheme(resolvedTrain);
            if (detectedTheme !== lastDetectedTrainTheme) {
                lastDetectedTrainTheme = detectedTheme;
                const layoutEl = document.querySelector(".telem-layout");
                if (layoutEl && layoutEl.getAttribute("data-theme") === "follow-train") {
                    layoutEl.setAttribute("data-train-theme", detectedTheme);
                    window.dispatchEvent(new CustomEvent("tsw6:theme", { detail: { theme: "follow-train", trainTheme: detectedTheme } }));
                }
            }

            if (simTimeEl && isLive) {
                simTimeEl.textContent = dateTime;
            }
        } catch (err) {
            if (streamDot) streamDot.classList.remove("is-live");
        }
    }

    /* When the DOM is fully loaded, initializes themes, verifies session, mounts views, and starts polling */
    document.addEventListener("DOMContentLoaded", async function () {
        applyTheme(window.TSWTheme.getCurrent());

        const username = await verifySession();
        const usernameEl = document.getElementById("header-username");
        if (username && usernameEl) {
            usernameEl.textContent = username;
        }

        const logoutBtn = document.getElementById("logout-btn");
        if (logoutBtn) {
            logoutBtn.addEventListener("click", handleLogout);
        }

        setupRecordingControls();
        setupMenuDropdown();
        setupSeamlessNavigation();

        const toastCloseBtn = document.getElementById("telem-global-toast-close");
        const toastEl = document.getElementById("telem-global-toast");
        if (toastCloseBtn && toastEl) {
            toastCloseBtn.addEventListener("click", function () {
                toastEl.hidden = true;
            });
        }

        ensureSettingsViewMounted();
        ensureRecordingsViewMounted();

        await updateHeaderTelemetry();
        pollTimer = setInterval(updateHeaderTelemetry, HEADER_POLL_MS);
    });
})();
