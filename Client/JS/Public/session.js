/* Here lies the JavaScript concerned with public layout sessions */
/* This handles checking user authentication, managing login state across public pages, clearing cached local data, and performing clean logouts */
/* Remember consistency is key */

(function () {
    /* Here we define the storage keys used to store authentication tokens and active game connections */
    const TOKEN_KEY = "tsw6ti_session_token";
    const CONNECTION_KEY = "tsw6ti_active_connection";

    /* Helper function to generate standard Authorization headers with a Bearer token */
    function authHeader(token) {
        return { Authorization: "Bearer " + token };
    }

    /* Checks local storage to see if an active TSW6 IP address and API key are saved */
    function hasActiveConnection() {
        try {
            const raw = localStorage.getItem(CONNECTION_KEY);
            if (!raw) return false;
            const parsed = JSON.parse(raw);
            return Boolean(parsed && parsed.ipAddress && parsed.apiKey);
        } catch (err) {
            return false;
        }
    }

    /* Fetches the current authenticated user's profile from the backend session endpoint */
    async function getUser() {
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) return null;
        try {
            const response = await fetch("/session", { headers: authHeader(token) });
            if (response.ok) {
                const data = await response.json();
                return data.username;
            }
            if (response.status === 401) localStorage.removeItem(TOKEN_KEY);
        } catch (err) {
        }
        return null;
    }

    /* List of all local storage keys that should be wiped clean on logout or account reset */
    const LOCAL_KEYS_TO_CLEAR = [
        TOKEN_KEY,
        CONNECTION_KEY,
        "tsw6ti_theme",
        "tsw6ti_accent_color",
        "tsw6ti_speed_unit"
    ];

    /* List of all session storage keys associated with live telemetry recording to clear */
    const SESSION_KEYS_TO_CLEAR = [
        "tsw6ti_is_recording",
        "tsw6ti_recording_started_at",
        "tsw6ti_telemetry_state"
    ];

    /* Deletes the IndexedDB database where high-frequency recording telemetry samples are stored */
    function clearRecorderIndexedDb() {
        return new Promise(function (resolve) {
            if (!window.indexedDB) {
                resolve();
                return;
            }
            try {
                const req = window.indexedDB.deleteDatabase("tsw6ti_recorder_v1");
                req.onsuccess = function () { resolve(); };
                req.onerror = function () { resolve(); };
                req.onblocked = function () { resolve(); };
            } catch (err) {
                resolve();
            }
        });
    }

    /* Wipes all client-side stored telemetry data, session states, and IndexedDB stores */
    async function clearAllLocalData() {
        LOCAL_KEYS_TO_CLEAR.forEach(function (k) {
            try { localStorage.removeItem(k); } catch (err) { /* ignore */ }
        });
        SESSION_KEYS_TO_CLEAR.forEach(function (k) {
            try { sessionStorage.removeItem(k); } catch (err) { /* ignore */ }
        });
        await clearRecorderIndexedDb();
    }

    /* Logs the user out by clearing local data, notifying the backend, and redirecting home */
    async function logout() {
        const token = localStorage.getItem(TOKEN_KEY);
        await clearAllLocalData();
        if (token) {
            try {
                await fetch("/logout", { method: "POST", headers: authHeader(token) });
            } catch (err) { /* ignore */ }
        }
        window.location.href = "/";
    }

    /* Public session helper API exposed on window */
    window.TSWSession = {
        clearLocalData: clearAllLocalData,
        logout: logout
    };

    /* Updates visibility of guest vs user elements across the public layout header and page */
    function render(username) {
        const loggedIn = username !== null;
        const connected = loggedIn && hasActiveConnection();

        /* Toggles elements meant only for guests (unauthenticated visitors) */
        document.querySelectorAll('[data-auth="guest"]').forEach(function (el) {
            el.hidden = loggedIn;
        });

        /* Toggles elements meant for logged in users, considering if they have connected to TSW6 */
        document.querySelectorAll('[data-auth="user"]').forEach(function (el) {
            const connState = el.getAttribute("data-connection");
            if (connState === "connected") {
                el.hidden = !connected;
            } else if (connState === "disconnected") {
                el.hidden = !loggedIn || connected;
            } else {
                el.hidden = !loggedIn;
            }
        });

        /* Shows user account badge in header with their username and logout button */
        const account = document.getElementById("header-account");
        if (account) {
            account.hidden = !loggedIn;
            if (loggedIn) {
                document.getElementById("header-username").textContent = username;
            }
        }
    }

    /* When the DOM is ready, hook up the logout button listener and check active user session */
    document.addEventListener("DOMContentLoaded", async function () {
        const logoutBtn = document.getElementById("logout-btn");
        if (logoutBtn) logoutBtn.addEventListener("click", logout);
        render(await getUser());
    });
})();
