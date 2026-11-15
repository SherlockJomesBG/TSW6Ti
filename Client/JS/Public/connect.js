/* Here lies the JavaScript concerned with the Connect page */
/* This handles browser extension gating, mobile checks, saved connections, testing TSW6 connectivity and loading markdown guides */
/* Remember consistency is key */

(function () {
    /* Constant key for our authentication token in browser storage */
    const TOKEN_KEY = "tsw6ti_session_token";

    /* Download package URLs for the browser extension */
    const EXTENSION_URLS = {
        chrome: "/extensions/chromium.zip",
        chromium: "/extensions/chromium.zip"
    };

    /* Cached DOM references for forms, gates, tables and alert banners */
    const form = document.getElementById("connect-form");
    const extGate = document.getElementById("connect-ext-gate");
    const mobileGate = document.getElementById("connect-mobile-gate");
    const extRecheckBtn = document.getElementById("ext-recheck-btn");
    const extContinueBtn = document.getElementById("ext-continue-btn");
    const tbody = document.getElementById("connections-body");
    const alertContainer = document.getElementById("alert-container");

    /* Constructs headers containing the current session token for API requests */
    function authHeaders(extra) {
        return Object.assign(
            { Authorization: "Bearer " + localStorage.getItem(TOKEN_KEY) },
            extra
        );
    }

    /* Renders user feedback alerts in the dedicated alert container */
    function showAlert(message, type) {
        alertContainer.innerHTML = "";
        const div = document.createElement("div");
        div.className = "alert alert-" + type;
        div.setAttribute("role", "alert");
        div.textContent = message;
        alertContainer.appendChild(div);
    }

    /* Masks the API key so only the last few characters remain visible */
    function maskKey(key) {
        return key.length <= 4 ? "****" : "****" + key.slice(-4);
    }

    /* Populates the table with previously saved game connection endpoints */
    function renderConnections(connections) {
        tbody.innerHTML = "";
        if (connections.length === 0) {
            const tr = document.createElement("tr");
            tr.className = "connect-table-empty";
            const td = document.createElement("td");
            td.colSpan = 3;
            td.textContent = "No saved connections yet";
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }

        connections.forEach(function (conn) {
            const tr = document.createElement("tr");
            tr.dataset.id = conn.connectionID;
            tr.title = "Click to fill the form";

            const ipTd = document.createElement("td");
            ipTd.textContent = conn.ipAddress;
            const keyTd = document.createElement("td");
            keyTd.textContent = maskKey(conn.apiKey);

            const delTd = document.createElement("td");
            const delBtn = document.createElement("button");
            delBtn.type = "button";
            delBtn.className = "connect-delete-btn";
            delBtn.title = "Delete connection";
            delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
            delBtn.addEventListener("click", function (event) {
                event.stopPropagation();
                deleteConnection(conn.connectionID);
            });
            delTd.appendChild(delBtn);

            tr.appendChild(ipTd);
            tr.appendChild(keyTd);
            tr.appendChild(delTd);
            tr.addEventListener("click", function () {
                form.elements["ipAddress"].value = conn.ipAddress;
                form.elements["apiKey"].value = conn.apiKey;
            });
            tbody.appendChild(tr);
        });
    }

    /* Fetches all saved connection records from the backend */
    async function loadConnections() {
        const response = await fetch("/connections", { headers: authHeaders() });
        if (response.status === 401) {
            localStorage.removeItem(TOKEN_KEY);
            window.location.href = "/auth";
            return;
        }
        const data = await response.json();
        renderConnections(data.connections || []);
    }

    /* Deletes a specific saved connection by its record ID */
    async function deleteConnection(id) {
        try {
            const response = await fetch("/connections/" + id, {
                method: "DELETE",
                headers: authHeaders()
            });
            if (response.status === 401) {
                window.location.href = "/auth";
                return;
            }
            await loadConnections();
        } catch (err) {
            showAlert("Could not delete connection", "danger");
        }
    }

    /* Handles submission: tests TSW6 connectivity via the local bridge then stores the details */
    async function handleSubmit(event) {
        event.preventDefault();
        const ipAddress = form.elements["ipAddress"].value.trim();
        const apiKey = form.elements["apiKey"].value.trim();

        if (!ipAddress || !apiKey) {
            showAlert("Please enter both an IP address and an API key", "danger");
            return;
        }

        const btn = form.querySelector(".auth-submit-btn");
        const btnLabel = btn ? btn.querySelector("span") : null;
        const originalText = btnLabel ? btnLabel.textContent : "Connect";

        btn.disabled = true;
        if (btnLabel) btnLabel.textContent = "Connecting...";

        try {
            const connResult = await window.TSW6.connect(ipAddress, apiKey);
            if (!connResult.ok) {
                showAlert(connResult.message || "Could not connect to TSW6", "danger");
                btn.disabled = false;
                if (btnLabel) btnLabel.textContent = originalText;
                return;
            }

            const response = await fetch("/connections", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ ipAddress, apiKey })
            });
            if (response.status === 401) {
                window.location.href = "/auth";
                return;
            }
            const result = await response.json();
            if (result.status === "success") {
                showAlert("Connected to TSW6 and connection saved", "success");
                await loadConnections();
                window.location.href = "/dashboard";
                return;
            } else {
                showAlert(result.message || "Connected to TSW6, but could not save connection", "warning");
                window.location.href = "/dashboard";
                return;
            }
        } catch (err) {
            showAlert("Could not reach the server", "danger");
        }
        btn.disabled = false;
        if (btnLabel) btnLabel.textContent = originalText;
    }

    /* Configures the show/hide password and key visibility toggle button */
    function setupPasswordToggles() {
        document.querySelectorAll(".auth-input-toggle").forEach(function (toggle) {
            toggle.addEventListener("click", function () {
                const input = toggle.parentElement.querySelector("input");
                const icon = toggle.querySelector("i");
                if (!input) return;
                const masked = input.classList.contains("connect-key-masked");
                if (masked) {
                    input.classList.remove("connect-key-masked");
                    if (icon) icon.className = "fa-regular fa-eye";
                } else {
                    input.classList.add("connect-key-masked");
                    if (icon) icon.className = "fa-regular fa-eye-slash";
                }
            });
        });
    }

    /* Neutralises browser autofill on sensitive IP and API key inputs until focused */
    function setupAntiAutofill() {
        if (!form) return;
        const fields = [form.elements["ipAddress"], form.elements["apiKey"]].filter(Boolean);
        fields.forEach(function (input) {
            input.value = "";
            const unlock = function () {
                input.removeAttribute("readonly");
            };
            input.addEventListener("focus", unlock, { once: true });
            input.addEventListener("pointerdown", unlock, { once: true });
        });
    }

    /* Parses markdown blockquotes into styled alerts (notes, tips, warnings) */
    function applyAlerts(container) {
        const titles = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };
        container.querySelectorAll("blockquote").forEach(function (quote) {
            const first = quote.querySelector("p");
            if (!first) return;
            const match = first.innerHTML.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br\s*\/?>)?\s*/i);
            if (!match) return;
            const type = match[1].toUpperCase();
            first.innerHTML = first.innerHTML.slice(match[0].length);
            quote.classList.add("md-alert", "md-alert-" + type.toLowerCase());
            const title = document.createElement("div");
            title.className = "md-alert-title";
            title.textContent = titles[type];
            quote.insertBefore(title, quote.firstChild);
        });
    }

    /* Fetches and renders the markdown connection setup guide */
    async function loadGuide() {
        const body = document.getElementById("connect-guide-body");
        if (!body) return;
        try {
            const response = await fetch("/Assets/Guides/connect.md");
            if (!response.ok) throw new Error("HTTP " + response.status);
            const markdown = await response.text();
            body.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
            applyAlerts(body);
        } catch (err) {
            body.textContent = "Could not load the guide.";
        }
    }

    /* Detects whether the TSW6Ti Local Connector extension has injected its bridge */
    function detectExtension() {
        return Boolean(
            window.TSW6 &&
            typeof window.TSW6.hasExtension === "function" &&
            window.TSW6.hasExtension()
        );
    }

    /* Checks if the client device is a mobile or tablet environment */
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

    /* Displays the mobile gate banner informing the user that desktop is required */
    function showMobileGate() {
        if (extGate) extGate.style.display = "none";
        if (form) form.style.display = "none";
        if (mobileGate) mobileGate.style.display = "flex";
        const layout = document.querySelector(".connect-layout");
        if (layout) layout.classList.add("is-mobile-blocked");

        const params = new URLSearchParams(window.location.search);
        if (params.get("from_telem") === "1") {
            showAlert(
                "The Telemetry Interface requires a desktop browser with extension support. You have been redirected to the Connect page.",
                "warning"
            );
        }
    }

    /* Displays the main connection form once all prerequisites are satisfied */
    function showConnectForm() {
        if (mobileGate) mobileGate.style.display = "none";
        if (extGate) extGate.style.display = "none";
        if (form) form.style.display = "block";
    }

    /* Displays the extension gate modal prompting the user to install the browser extension */
    function showExtensionGate() {
        if (mobileGate) mobileGate.style.display = "none";
        if (form) form.style.display = "none";
        if (extGate) extGate.style.display = "flex";
    }

    /* Sets up extension installation buttons, re-check triggers and window focus listeners */
    function setupExtensionGate() {
        document.querySelectorAll(".connect-ext-browser-btn").forEach(function (link) {
            const key = link.dataset.browser;
            const targetUrl = (key && EXTENSION_URLS[key]) || "#";
            link.setAttribute("href", targetUrl);
            if (/^https?:\/\//i.test(targetUrl)) {
                link.setAttribute("target", "_blank");
            }
            link.addEventListener("click", function (event) {
                const href = link.getAttribute("href") || "";
                if (!href || href.startsWith("#")) {
                    event.preventDefault();
                    const label = link.querySelector("span") ? link.querySelector("span").textContent : "Browser";
                    showAlert(
                        label + " store link is a placeholder right now. Install the extension locally from Extensions/ (or AMO) and click Check Again.",
                        "warning"
                    );
                }
            });
        });

        if (extRecheckBtn) {
            extRecheckBtn.addEventListener("click", function () {
                if (detectExtension()) {
                    showConnectForm();
                    showAlert("TSW6Ti Local Connector detected! Enter your TSW6 IP address and API key.", "success");
                    return;
                }
                /* Newly installed extensions only inject document_start content scripts on reload */
                window.location.reload();
            });
        }

        if (extContinueBtn) {
            extContinueBtn.addEventListener("click", function () {
                showConnectForm();
                if (window.location.protocol === "https:") {
                    showAlert(
                        "Continuing without the extension over HTTPS — direct local HTTP game connections may be blocked by your browser unless you use a custom HTTPS proxy.",
                        "warning"
                    );
                }
            });
        }

        window.addEventListener("focus", function () {
            if (extGate && extGate.style.display !== "none" && detectExtension()) {
                showConnectForm();
                showAlert("TSW6Ti Local Connector detected!", "success");
            }
        });

        if (detectExtension()) {
            showConnectForm();
        } else {
            showExtensionGate();
        }
    }

    /* Bootstraps the connect page once the DOM is ready */
    document.addEventListener("DOMContentLoaded", function () {
        loadGuide();
        if (!localStorage.getItem(TOKEN_KEY)) {
            window.location.href = "/auth";
            return;
        }

        if (isMobileDevice()) {
            showMobileGate();
            return;
        }

        setupExtensionGate();
        setupAntiAutofill();
        form.addEventListener("submit", handleSubmit);
        setupPasswordToggles();
        loadConnections().catch(function () {
            showAlert("Could not load connections", "danger");
        });
    });
})();
