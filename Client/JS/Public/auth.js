/* Here lies the JavaScript concerned with user authentication */
/* This handles login submissions, user registrations, validation errors, session checks, password visibility toggles, and token storage */
/* Remember consistency is key */

(function () {
    /* Key for user authentication token in local storage and post-login destination URL */
    const TOKEN_KEY = "tsw6ti_session_token";
    const REDIRECT_URL = "/";

    /* Finds the login form, registration form, and alert banner container */
    const loginForm = document.querySelector(".auth-form-login");
    const registerForm = document.querySelector(".auth-form-register");
    const alertContainer = document.getElementById("alert-container");
    let alertTimer = null;

    /* Shows a dismissible notification toast banner at the top of the authentication card */
    function showAlert(message, type) {
        if (!alertContainer) return;
        const kind = type || "info";
        const iconMap = {
            success: "fa-solid fa-circle-check",
            danger: "fa-solid fa-circle-exclamation",
            warning: "fa-solid fa-triangle-exclamation",
            info: "fa-solid fa-circle-info"
        };

        alertContainer.innerHTML = "";
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
        alertContainer.appendChild(div);

        /* Automatically removes the alert after 5 seconds */
        if (alertTimer) clearTimeout(alertTimer);
        alertTimer = setTimeout(function () {
            if (div.parentNode === alertContainer) {
                div.remove();
            }
        }, 5000);
    }

    /* Clears inline validation error callouts and red borders from the form */
    function clearFormError(form) {
        if (!form) return;
        const box = form.querySelector(".auth-inline-error");
        if (box) {
            box.hidden = true;
            box.innerHTML = "";
        }
        form.querySelectorAll(".is-invalid").forEach(function (el) {
            el.classList.remove("is-invalid");
        });
    }

    /* Highlights an invalid form field and renders an inline error alert message */
    function showFormError(form, message, fieldEl) {
        clearFormError(form);
        if (form) {
            const box = form.querySelector(".auth-inline-error");
            if (box) {
                const icon = document.createElement("i");
                icon.className = "fa-solid fa-circle-exclamation";
                icon.setAttribute("aria-hidden", "true");
                const span = document.createElement("span");
                span.textContent = message;
                box.appendChild(icon);
                box.appendChild(span);
                box.hidden = false;
            }
            if (fieldEl) {
                const wrapper = fieldEl.closest(".auth-input-group, .auth-legal-check");
                if (wrapper) wrapper.classList.add("is-invalid");
                fieldEl.focus();
            }
        }
        showAlert(message, "danger");
    }

    /* Clears error indicators whenever the user starts typing into an input field */
    function bindErrorClear(form) {
        if (!form) return;
        form.querySelectorAll("input").forEach(function (input) {
            const evt = input.type === "checkbox" ? "change" : "input";
            input.addEventListener(evt, function () {
                clearFormError(form);
            });
        });
    }

    /* Toggles the submit button disabled state during network communication */
    function setBusy(form, busy) {
        const btn = form.querySelector(".auth-submit-btn");
        if (btn) btn.disabled = busy;
    }

    /* Helper function to make JSON POST requests */
    async function postJSON(url, body) {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        return response.json();
    }

    /* Gets the stored session token from local storage */
    function getToken() {
        return localStorage.getItem(TOKEN_KEY);
    }

    /* Saves a newly authenticated session token into local storage */
    function setToken(token) {
        localStorage.setItem(TOKEN_KEY, token);
    }

    /* Deletes the session token from local storage */
    function clearToken() {
        localStorage.removeItem(TOKEN_KEY);
    }

    /* Checks with the backend to verify if the stored session token is still valid */
    async function checkSession() {
        const token = getToken();
        if (!token) return false;
        try {
            const response = await fetch("/session", {
                headers: { Authorization: "Bearer " + token }
            });
            if (response.ok) return true;
            clearToken();
        } catch (err) {
        }
        return false;
    }

    /* Handles the login form submission: validates credentials and sets session token */
    async function handleLogin(event) {
        event.preventDefault();
        const form = event.currentTarget;
        clearFormError(form);
        const userEl = form.elements["username"];
        const passEl = form.elements["password"];
        const username = userEl.value.trim();
        const password = passEl.value;

        /* Validates that both username and password have been filled in */
        if (!username) {
            showFormError(form, "Please enter your username.", userEl);
            return;
        }
        if (!password) {
            showFormError(form, "Please enter your password.", passEl);
            return;
        }

        setBusy(form, true);
        try {
            const result = await postJSON("/login", { username, password });
            if (result.status === "success" && result.token) {
                setToken(result.token);
                window.location.href = REDIRECT_URL;
                return;
            }
            showFormError(form, result.message || "Login failed.", passEl);
        } catch (err) {
            showFormError(form, "Could not reach the server. Please try again.");
        }
        setBusy(form, false);
    }

    /* Handles the registration form submission: validates passwords, checks legal terms, and signs up */
    async function handleRegister(event) {
        event.preventDefault();
        const form = event.currentTarget;
        clearFormError(form);

        const userEl = form.elements["username"];
        const passEl = form.elements["password"];
        const confirmEl = form.elements["confirm_password"];
        const legalEl = form.elements["accept_legal"];

        const username = userEl.value.trim();
        const password = passEl.value;
        const confirm = confirmEl.value;
        const acceptLegal = Boolean(legalEl && legalEl.checked);

        /* Client-side validation checks for usernames, password rules, and legal agreements */
        if (!username) {
            showFormError(form, "Please enter a username.", userEl);
            return;
        }
        if (username.length < 2 || username.length > 64) {
            showFormError(form, "Username must be between 2 and 64 characters.", userEl);
            return;
        }
        if (!password) {
            showFormError(form, "Please enter a password.", passEl);
            return;
        }
        if (password.length < 8) {
            showFormError(form, "Password must be at least 8 characters long.", passEl);
            return;
        }
        if (password.length > 256) {
            showFormError(form, "Password must be 256 characters or fewer.", passEl);
            return;
        }
        if (!confirm) {
            showFormError(form, "Please confirm your password.", confirmEl);
            return;
        }
        if (password !== confirm) {
            showFormError(form, "Passwords do not match.", confirmEl);
            return;
        }
        if (!acceptLegal) {
            showFormError(form, "Please tick the box to accept the Terms & Conditions and Privacy Policy.", legalEl);
            return;
        }

        setBusy(form, true);
        try {
            const result = await postJSON("/register", {
                username: username,
                password: password,
                acceptLegal: true
            });
            if (result.status !== "success") {
                showFormError(form, result.message || "Registration failed.", userEl);
                setBusy(form, false);
                return;
            }
            /* Automatically logs the user in upon successful registration */
            const login = await postJSON("/login", { username, password });
            if (login.status === "success" && login.token) {
                setToken(login.token);
                window.location.href = REDIRECT_URL;
                return;
            }
            showAlert("Registered! Please log in.", "success");
            document.getElementById("tab-login").checked = true;
        } catch (err) {
            showFormError(form, "Could not reach the server. Please try again.");
        }
        setBusy(form, false);
    }

    /* Enables the show/hide password eye icon toggle on password inputs */
    function setupPasswordToggles() {
        document.querySelectorAll(".auth-input-toggle").forEach(function (toggle) {
            toggle.addEventListener("click", function () {
                const input = toggle.parentElement.querySelector("input");
                const icon = toggle.querySelector("i");
                const show = input.type === "password";
                input.type = show ? "text" : "password";
                icon.className = show ? "fa-regular fa-eye" : "fa-regular fa-eye-slash";
            });
        });
    }

    /* Public authentication API exposed on window */
    window.TSWAuth = {
        getToken: getToken,
        checkSession: checkSession,
        authFetch: function (url, options) {
            options = options || {};
            options.headers = Object.assign({}, options.headers, {
                Authorization: "Bearer " + getToken()
            });
            return fetch(url, options);
        },
        logout: async function () {
            const token = getToken();
            clearToken();
            if (token) {
                try {
                    await fetch("/logout", {
                        method: "POST",
                        headers: { Authorization: "Bearer " + token }
                    });
                } catch (err) { /* ignore */ }
            }
            window.location.href = "/auth";
        }
    };

    /* When the DOM is ready, binds form submit handlers, password toggles, and redirects if already logged in */
    document.addEventListener("DOMContentLoaded", async function () {
        if (loginForm) {
            loginForm.addEventListener("submit", handleLogin);
            bindErrorClear(loginForm);
        }
        if (registerForm) {
            registerForm.addEventListener("submit", handleRegister);
            bindErrorClear(registerForm);
        }
        setupPasswordToggles();

        /* If user already has a valid session token, redirect directly to dashboard / home */
        if (await checkSession()) {
            window.location.href = REDIRECT_URL;
        }
    });
})();
