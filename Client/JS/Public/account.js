/* Here lies the JavaScript concerned with the Account management page */
/* This handles profile details, password updates, saved connections, data exports, retention policies and account deletion */
/* Remember consistency is key */

(function () {
    "use strict";

    /* Storage key constants for authentication tokens and active connection states */
    const TOKEN_KEY = "tsw6ti_session_token";
    const CONNECTION_KEY = "tsw6ti_active_connection";

    /* Handy shorthand helper for grabbing elements by their ID */
    function qs(id) {
        return document.getElementById(id);
    }

    /* Retrieves the current user's session token from local storage */
    function getToken() {
        return localStorage.getItem(TOKEN_KEY);
    }

    /* Appends bearer authorization headers to backend fetch requests */
    function authHeaders(extra) {
        return Object.assign({ Authorization: "Bearer " + getToken() }, extra);
    }

    /* Timer handle for automatically dismissing alerts */
    let alertTimer = null;

    /* Shows alert messages with auto-dismiss timers */
    function showAlert(message, type) {
        const container = qs("alert-container");
        if (!container) return;
        const kind = type || "info";
        const iconMap = {
            success: "fa-solid fa-circle-check",
            danger: "fa-solid fa-circle-exclamation",
            warning: "fa-solid fa-triangle-exclamation",
            info: "fa-solid fa-circle-info"
        };

        container.innerHTML = "";
        const div = document.createElement("div");
        div.className = "alert alert-" + kind;
        div.setAttribute("role", "alert");

        const body = document.createElement("span");
        body.className = "alert-toast-content";
        const icon = document.createElement("i");
        icon.className = iconMap[kind] || iconMap.info;
        icon.setAttribute("aria-hidden", "true");
        const text = document.createElement("span");
        text.textContent = message;
        body.appendChild(icon);
        body.appendChild(text);

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "alert-toast-close";
        closeBtn.setAttribute("aria-label", "Dismiss notification");
        closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        closeBtn.addEventListener("click", function () {
            div.remove();
        });

        div.appendChild(body);
        div.appendChild(closeBtn);
        container.appendChild(div);

        if (alertTimer) clearTimeout(alertTimer);
        alertTimer = setTimeout(function () {
            if (div.parentNode === container) {
                div.remove();
            }
        }, 5000);
    }

    /* Masks sensitive API keys for safe display in connection lists */
    function maskKey(key) {
        const str = String(key || "");
        return str.length <= 4 ? "****" : "****" + str.slice(-4);
    }

    /* Checks if an active connection is configured to show or hide the dashboard shortcut button */
    function syncDashboardShortcut() {
        const dashBtn = qs("account-dashboard-link");
        if (!dashBtn) return;
        try {
            const raw = localStorage.getItem(CONNECTION_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            dashBtn.hidden = !(parsed && parsed.ipAddress && parsed.apiKey);
        } catch (err) {
            dashBtn.hidden = true;
        }
    }

    /* Sets up password visibility toggle icons */
    function setupPasswordToggles() {
        document.querySelectorAll(".auth-input-toggle").forEach(function (toggle) {
            toggle.addEventListener("click", function () {
                const input = toggle.parentElement.querySelector("input");
                const icon = toggle.querySelector("i");
                if (!input || !icon) return;
                const show = input.type === "password";
                input.type = show ? "text" : "password";
                icon.className = show ? "fa-regular fa-eye" : "fa-regular fa-eye-slash";
            });
        });
    }

    /* Formats ISO timestamp strings into friendly session expiration notices */
    function formatExpiry(isoStr) {
        if (!isoStr) return "Login Session: Active";
        const d = new Date(isoStr);
        if (Number.isNaN(d.getTime())) return "Login Session: Active";
        return "Login Session Expires " + d.toLocaleDateString();
    }

    /* Fetches overview account metrics, profile stats and retention policies */
    async function loadOverview() {
        const res = await fetch("/api/account", { headers: authHeaders() });
        if (res.status === 401) {
            localStorage.removeItem(TOKEN_KEY);
            window.location.href = "/auth";
            return null;
        }
        const data = await res.json();
        if (!res.ok || data.status !== "success" || !data.account) {
            throw new Error(data.message || "Failed to load account details");
        }

        const acc = data.account;
        if (qs("stat-username")) qs("stat-username").textContent = acc.username;
        if (qs("stat-connections")) qs("stat-connections").textContent = String(acc.connectionCount ?? 0);
        if (qs("stat-recordings")) qs("stat-recordings").textContent = String(acc.recordingCount ?? 0);
        if (qs("stat-config")) qs("stat-config").textContent = acc.hasDashboardConfig ? "Saved" : "Default";
        if (qs("account-session-expiry")) qs("account-session-expiry").textContent = formatExpiry(acc.sessionExpiresAt);
        if (qs("account-username-input")) qs("account-username-input").value = acc.username;
        if (qs("header-username")) qs("header-username").textContent = acc.username;
        syncRetentionControls(acc);
        return acc;
    }

    /* Synchronises the retention dropdown with server-side limits and current settings */
    function syncRetentionControls(acc) {
        const select = qs("account-retention-select");
        const help = qs("account-retention-help");
        if (!select) return;

        const maxDays = acc.maxRecordingRetentionDays;
        Array.from(select.options).forEach(function (opt) {
            const val = Number(opt.value);
            const disallowed = typeof maxDays === "number" && maxDays > 0 && (val === 0 || val > maxDays);
            opt.disabled = disallowed;
            opt.hidden = disallowed;
        });

        const current = acc.recordingRetentionDays !== undefined && acc.recordingRetentionDays !== null
            ? String(acc.recordingRetentionDays)
            : String(acc.defaultRecordingRetentionDays ?? 365);

        if (Array.from(select.options).some(function (opt) { return opt.value === current && !opt.disabled; })) {
            select.value = current;
        } else if (typeof maxDays === "number" && maxDays > 0) {
            const customOpt = document.createElement("option");
            customOpt.value = String(maxDays);
            customOpt.textContent = "Delete recordings older than " + maxDays + " days (Server Max)";
            select.appendChild(customOpt);
            select.value = String(maxDays);
        }

        if (help) {
            const baseText = "Expired login sessions are automatically removed after 7 days. Choose how long finished telemetry recordings remain stored before automatic deletion.";
            help.textContent = typeof maxDays === "number" && maxDays > 0
                ? baseText + " Server policy caps retention at " + maxDays + " days."
                : baseText;
        }
    }

    /* Loads and displays saved connection endpoints with delete actions */
    async function loadConnections() {
        const tbody = qs("account-connections-body");
        if (!tbody) return;
        const res = await fetch("/connections", { headers: authHeaders() });
        if (res.status === 401) {
            window.location.href = "/auth";
            return;
        }
        const data = await res.json();
        const connections = Array.isArray(data.connections) ? data.connections : [];

        tbody.innerHTML = "";
        if (!connections.length) {
            const tr = document.createElement("tr");
            const td = document.createElement("td");
            td.colSpan = 3;
            td.className = "account-table-muted";
            td.textContent = "No saved connections.";
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }

        connections.forEach(function (conn) {
            const tr = document.createElement("tr");

            const ipTd = document.createElement("td");
            ipTd.textContent = conn.ipAddress;

            const keyTd = document.createElement("td");
            keyTd.textContent = maskKey(conn.apiKey);

            const delTd = document.createElement("td");
            const delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "account-conn-del-btn";
            delBtn.title = "Delete saved connection";
            delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
            delBtn.addEventListener("click", async function () {
                await fetch("/connections/" + encodeURIComponent(conn.connectionID), {
                    method: "DELETE",
                    headers: authHeaders()
                });
                await Promise.all([loadConnections(), loadOverview()]);
                showAlert("Saved connection deleted.", "success");
            });

            delTd.appendChild(delBtn);
            tr.appendChild(ipTd);
            tr.appendChild(keyTd);
            tr.appendChild(delTd);
            tbody.appendChild(tr);
        });
    }

    /* Submits username updates to the server */
    async function handleUsernameSubmit(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const username = form.elements["username"].value.trim();
        if (!username) return;

        try {
            const res = await fetch("/api/account/profile", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ username: username })
            });
            const data = await res.json();
            if (!res.ok || data.status !== "success") {
                showAlert(data.message || "Could not update username.", "danger");
                return;
            }
            await loadOverview();
            showAlert("Username updated.", "success");
        } catch (err) {
            showAlert("Could not reach the server.", "danger");
        }
    }

    /* Submits password changes and revokes competing user sessions */
    async function handlePasswordSubmit(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const currentPassword = form.elements["currentPassword"].value;
        const newPassword = form.elements["newPassword"].value;
        const confirmNewPassword = form.elements["confirmNewPassword"].value;

        if (newPassword !== confirmNewPassword) {
            showAlert("New passwords do not match.", "danger");
            return;
        }

        try {
            const res = await fetch("/api/account/profile", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({
                    currentPassword: currentPassword,
                    newPassword: newPassword
                })
            });
            const data = await res.json();
            if (!res.ok || data.status !== "success") {
                showAlert(data.message || "Could not update password.", "danger");
                return;
            }
            form.reset();
            showAlert("Password updated. Other sessions have been signed out.", "success");
        } catch (err) {
            showAlert("Could not reach the server.", "danger");
        }
    }

    /* Triggers account data archive downloads in JSON or ZIP format */
    async function downloadExport(format) {
        const url = format === "json" ? "/api/account/export?format=json" : "/api/account/export";
        try {
            const res = await fetch(url, { headers: authHeaders() });
            if (res.status === 401) {
                window.location.href = "/auth";
                return;
            }
            if (!res.ok) {
                throw new Error("Export failed");
            }
            const blob = await res.blob();
            const disposition = res.headers.get("Content-Disposition") || "";
            const match = disposition.match(/filename="?([^"]+)"?/i);
            const filename = match ? match[1] : (format === "json" ? "TSW6_Account_Export.json" : "TSW6_Account_Export.zip");

            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 1000);
            showAlert("Your data export download has started.", "success");
        } catch (err) {
            showAlert(err.message || "Could not generate export.", "danger");
        }
    }

    /* Updates automatic telemetry recording retention periods */
    async function handleRetentionSubmit(event) {
        event.preventDefault();
        const select = qs("account-retention-select");
        const btn = qs("account-retention-btn");
        if (!select) return;

        const days = Number(select.value);
        if (btn) btn.disabled = true;

        try {
            const res = await fetch("/api/account/retention", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ recordingRetentionDays: days })
            });
            const data = await res.json();
            if (!res.ok || data.status !== "success") {
                showAlert(data.message || "Could not update retention policy.", "danger");
                return;
            }
            if (qs("stat-recordings") && typeof data.recordingCount === "number") {
                qs("stat-recordings").textContent = String(data.recordingCount);
            }
            const pruned = Number(data.prunedCount || 0);
            const msg = pruned > 0
                ? "Retention policy updated. Pruned " + pruned + " expired recording(s)."
                : "Retention policy updated.";
            showAlert(msg, "success");
        } catch (err) {
            showAlert("Could not reach the server.", "danger");
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /* Handles permanent account deletion and clears local credentials */
    async function handleDeleteAccount(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const password = form.elements["password"].value;
        const phrase = form.elements["confirmPhrase"].value.trim();

        if (phrase !== "DELETE") {
            showAlert('Please type "DELETE" to confirm account erasure.', "danger");
            return;
        }

        const btn = qs("account-delete-btn");
        if (btn) btn.disabled = true;

        try {
            const res = await fetch("/api/account", {
                method: "DELETE",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ password: password })
            });
            const data = await res.json();
            if (!res.ok || data.status !== "success") {
                showAlert(data.message || "Could not delete account.", "danger");
                if (btn) btn.disabled = false;
                return;
            }

            if (window.TSWSession && typeof window.TSWSession.clearLocalData === "function") {
                await window.TSWSession.clearLocalData();
            } else {
                localStorage.clear();
                sessionStorage.clear();
            }
            window.location.href = "/";
        } catch (err) {
            showAlert("Could not reach the server.", "danger");
            if (btn) btn.disabled = false;
        }
    }

    /* Initialises account page listeners and loads data on DOM ready */
    document.addEventListener("DOMContentLoaded", async function () {
        if (!getToken()) {
            window.location.href = "/auth";
            return;
        }

        syncDashboardShortcut();
        setupPasswordToggles();

        const userForm = qs("account-username-form");
        const passForm = qs("account-password-form");
        const retentionForm = qs("account-retention-form");
        const delForm = qs("account-delete-form");
        const zipBtn = qs("account-export-zip-btn");
        const jsonBtn = qs("account-export-json-btn");

        if (userForm) userForm.addEventListener("submit", handleUsernameSubmit);
        if (passForm) passForm.addEventListener("submit", handlePasswordSubmit);
        if (retentionForm) retentionForm.addEventListener("submit", handleRetentionSubmit);
        if (delForm) delForm.addEventListener("submit", handleDeleteAccount);
        if (zipBtn) zipBtn.addEventListener("click", function () { downloadExport("zip"); });
        if (jsonBtn) jsonBtn.addEventListener("click", function () { downloadExport("json"); });

        try {
            await Promise.all([loadOverview(), loadConnections()]);
        } catch (err) {
            showAlert(err.message || "Could not load account data.", "danger");
        }
    });
})();
