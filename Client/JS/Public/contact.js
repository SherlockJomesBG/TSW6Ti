/* Here lies the JavaScript concerned with the public contact page */
/* This handles form submission, enquiry validation, live character counting, feedback alerts, and user pre-fills */
/* Remember consistency is key */

(function () {
    "use strict";

    /* Key for user authentication token in local storage */
    const TOKEN_KEY = "tsw6ti_session_token";
    let alertTimer = null;

    /* Quick helper to look up elements by their element ID */
    function qs(id) {
        return document.getElementById(id);
    }

    /* Shows a dismissible notification toast banner with an icon at the top of the contact page */
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

        /* Automatically removes the alert toast after 5 seconds */
        if (alertTimer) clearTimeout(alertTimer);
        alertTimer = setTimeout(function () {
            if (div.parentNode === container) {
                div.remove();
            }
        }, 5000);
    }

    /* If the user is currently logged in, automatically fills in their username into the name field */
    async function prefillUsername() {
        const nameInput = qs("contact-name");
        const token = localStorage.getItem(TOKEN_KEY);
        if (!nameInput || !token || nameInput.value.trim()) return;

        try {
            const res = await fetch("/session", {
                headers: { Authorization: "Bearer " + token }
            });
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.authenticated && data.username && !nameInput.value.trim()) {
                nameInput.value = data.username;
            }
        } catch (err) {
            /* Optional prefill failure stays silent */
        }
    }

    /* Keeps track of message length and updates the 0 / 3000 counter in real-time */
    function updateCharCount() {
        const textarea = qs("contact-message");
        const counter = qs("contact-char-count");
        if (!textarea || !counter) return;
        counter.textContent = String(textarea.value.length) + " / 3000";
    }

    /* Validates form input and transmits the enquiry payload to the contact API endpoint */
    async function handleSubmit(event) {
        event.preventDefault();
        const form = qs("contact-form");
        const btn = qs("contact-submit-btn");
        const successPanel = qs("contact-success-panel");
        const ticketRefEl = qs("contact-ticket-ref");
        if (!form) return;

        const payload = {
            category: (qs("contact-category") && qs("contact-category").value) || "support",
            name: (qs("contact-name") && qs("contact-name").value.trim()) || "",
            replyTo: (qs("contact-reply-to") && qs("contact-reply-to").value.trim()) || "",
            subject: (qs("contact-subject") && qs("contact-subject").value.trim()) || "",
            message: (qs("contact-message") && qs("contact-message").value.trim()) || ""
        };

        /* Validates minimum length requirements before attempting transmission */
        if (payload.subject.length < 3) {
            showAlert("Please enter a subject of at least 3 characters.", "danger");
            return;
        }
        if (payload.message.length < 10) {
            showAlert("Please provide a message of at least 10 characters.", "danger");
            return;
        }

        const headers = { "Content-Type": "application/json" };
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) {
            headers.Authorization = "Bearer " + token;
        }

        if (btn) btn.disabled = true;
        try {
            const res = await fetch("/api/contact", {
                method: "POST",
                headers: headers,
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok || data.status !== "success") {
                showAlert((data && data.message) || "Could not submit your enquiry.", "danger");
                return;
            }

            /* Hides the form and displays the ticket confirmation panel */
            if (ticketRefEl) ticketRefEl.textContent = data.referenceId || "Submitted";
            form.hidden = true;
            if (successPanel) successPanel.hidden = false;
            showAlert("Enquiry submitted successfully.", "success");
        } catch (err) {
            showAlert("Could not reach the server. Please try again.", "danger");
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /* When the DOM is fully loaded, attaches input listeners and attempts to prefill username */
    document.addEventListener("DOMContentLoaded", function () {
        const form = qs("contact-form");
        const textarea = qs("contact-message");
        const resetBtn = qs("contact-send-another");
        const successPanel = qs("contact-success-panel");

        if (textarea) {
            textarea.addEventListener("input", updateCharCount);
            updateCharCount();
        }
        if (form) {
            form.addEventListener("submit", handleSubmit);
        }
        /* Allows the user to reset the form and send another enquiry */
        if (resetBtn) {
            resetBtn.addEventListener("click", function () {
                if (form) {
                    form.reset();
                    form.hidden = false;
                }
                if (successPanel) successPanel.hidden = true;
                updateCharCount();
                prefillUsername();
            });
        }

        prefillUsername();
    });
})();
