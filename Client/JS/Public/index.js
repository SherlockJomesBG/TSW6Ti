/* Here lies the JavaScript concerned with the public landing page */
/* This handles scrolling down to documentation, parsing the README markdown sections into interactive accordions, and managing expand/collapse controls */
/* Remember consistency is key */

(function () {
    "use strict";

    /* Finds the documentation container, expand/collapse all button, and scroll down button on the landing page */
    const container = document.getElementById("readme-container");
    const toggleAllBtn = document.getElementById("readme-toggle-all-btn");
    const scrollPromptBtn = document.getElementById("scroll-prompt-btn");

    /* Smoothly scrolls the viewport down to the documentation section when the scroll prompt arrow is clicked */
    if (scrollPromptBtn) {
        scrollPromptBtn.addEventListener("click", function (event) {
            event.preventDefault();
            const target = document.getElementById("readme-section");
            if (target) {
                target.scrollIntoView({ behavior: "smooth", block: "start" });
            }
        });
    }

    /* Bails out early if the readme documentation container doesn't exist on the page */
    if (!container) return;

    /* Determines the category badge, FontAwesome icon, and numbered index for each section title */
    function getMetaForTitle(title, index) {
        const lower = String(title || "").toLowerCase();
        let icon = "fa-solid fa-file-lines";
        let category = "DOCUMENTATION";

        if (lower.includes("about")) {
            icon = "fa-solid fa-circle-info";
            category = "OVERVIEW";
        } else if (lower.includes("tech") || lower.includes("stack") || lower.includes("architecture")) {
            icon = "fa-solid fa-layer-group";
            category = "TECH STACK";
        } else if (lower.includes("device") || lower.includes("support") || lower.includes("compatib") || lower.includes("platform")) {
            icon = "fa-solid fa-laptop-code";
            category = "DEVICE SUPPORT";
        } else if (lower.includes("security")) {
            icon = "fa-solid fa-shield-halved";
            category = "SECURITY & COMPLIANCE";
        } else if (lower.includes("gdpr") || lower.includes("privacy")) {
            icon = "fa-solid fa-user-shield";
            category = "DATA PRIVACY";
        } else if (lower.includes("ai") || lower.includes("robot")) {
            icon = "fa-solid fa-microchip";
            category = "DEVELOPMENT DISCLOSURE";
        } else if (lower.includes("next") || lower.includes("future") || lower.includes("roadmap")) {
            icon = "fa-solid fa-map-location-dot";
            category = "FUTURE ROADMAP";
        } else if (lower.includes("disclaimer") || lower.includes("license") || lower.includes("legal")) {
            icon = "fa-solid fa-scale-balanced";
            category = "LEGAL & TRADEMARKS";
        }

        const num = String(index + 1).padStart(2, "0");
        return { icon, category, num };
    }

    /* Parses GitHub-style alert callouts like [!NOTE] or [!WARNING] inside blockquotes */
    function applyAlerts(parentEl) {
        const titles = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };
        parentEl.querySelectorAll("blockquote").forEach(function (quote) {
            const first = quote.querySelector("p");
            if (!first) return;
            const match = first.innerHTML.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br\s*\/?>)?\s*/i);
            if (!match) return;
            const type = match[1].toUpperCase();
            first.innerHTML = first.innerHTML.slice(match[0].length);
            quote.classList.add("md-alert", "md-alert-" + type.toLowerCase());
            const titleEl = document.createElement("div");
            titleEl.className = "md-alert-title";
            titleEl.textContent = titles[type];
            quote.insertBefore(titleEl, quote.firstChild);
        });
    }

    /* Checks whether all accordion panels are currently open and toggles the main button icon and label */
    function updateToggleAllBtnState() {
        if (!toggleAllBtn) return;
        const accordions = container.querySelectorAll(".readme-accordion");
        if (accordions.length === 0) return;

        const allOpen = Array.from(accordions).every(function (acc) {
            return acc.open;
        });

        const icon = toggleAllBtn.querySelector("i");
        const span = toggleAllBtn.querySelector("span");

        if (allOpen) {
            if (icon) icon.className = "fa-solid fa-compress";
            if (span) span.textContent = "Collapse All";
        } else {
            if (icon) icon.className = "fa-solid fa-expand";
            if (span) span.textContent = "Expand All";
        }
    }

    /* When clicked, toggles all documentation accordion panels open or closed simultaneously */
    if (toggleAllBtn) {
        toggleAllBtn.addEventListener("click", function () {
            const accordions = container.querySelectorAll(".readme-accordion");
            if (accordions.length === 0) return;

            const shouldOpen = !Array.from(accordions).every(function (acc) {
                return acc.open;
            });

            accordions.forEach(function (acc) {
                acc.open = shouldOpen;
                const badge = acc.querySelector(".readme-summary-badge");
                if (badge) {
                    badge.textContent = shouldOpen ? "Collapse" : "Expand";
                }
            });

            updateToggleAllBtnState();
        });
    }

    /* Fetches the parsed README markdown from the server API and builds interactive accordion cards */
    async function loadReadme() {
        try {
            const response = await fetch("/api/readme");
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            const data = await response.json();
            const sections = data.sections || [];

            /* Renders an empty state placeholder if no sections were parsed */
            if (sections.length === 0) {
                container.innerHTML = `
                    <div class="readme-empty text-center p-5">
                        <i class="fa-solid fa-circle-exclamation fa-2x text-muted mb-2"></i>
                        <p class="text-muted small mb-0">No documentation sections found in README.md.</p>
                    </div>
                `;
                return;
            }

            container.innerHTML = "";

            /* Iterates through each parsed markdown section and constructs an accordion element */
            sections.forEach(function (section, index) {
                const meta = getMetaForTitle(section.title, index);
                const details = document.createElement("details");
                details.className = "readme-accordion";

                const summary = document.createElement("summary");
                summary.className = "readme-summary";

                const left = document.createElement("div");
                left.className = "readme-summary-left";

                const numBadge = document.createElement("span");
                numBadge.className = "readme-summary-num";
                numBadge.textContent = meta.num;

                const iconSpan = document.createElement("span");
                iconSpan.className = "readme-summary-icon";
                iconSpan.innerHTML = `<i class="${meta.icon}"></i>`;

                const titlesWrapper = document.createElement("div");
                titlesWrapper.className = "readme-titles-wrapper";

                const categorySpan = document.createElement("span");
                categorySpan.className = "readme-summary-category";
                categorySpan.textContent = meta.category;

                const titleSpan = document.createElement("span");
                titleSpan.className = "readme-summary-title";
                titleSpan.textContent = section.title;

                titlesWrapper.appendChild(categorySpan);
                titlesWrapper.appendChild(titleSpan);

                left.appendChild(numBadge);
                left.appendChild(iconSpan);
                left.appendChild(titlesWrapper);

                const right = document.createElement("div");
                right.className = "readme-summary-right";
                right.innerHTML = `
                    <span class="readme-summary-badge">Expand</span>
                    <i class="fa-solid fa-chevron-right readme-chevron"></i>
                `;

                summary.appendChild(left);
                summary.appendChild(right);

                const body = document.createElement("div");
                body.className = "readme-body markdown-body";

                /* Parses section markdown into HTML and sanitizes with DOMPurify */
                const rendered = typeof marked !== "undefined"
                    ? marked.parse(section.content || "")
                    : `<pre>${section.content || ""}</pre>`;

                body.innerHTML = typeof DOMPurify !== "undefined"
                    ? DOMPurify.sanitize(rendered)
                    : rendered;

                applyAlerts(body);

                /* Updates individual accordion badge text and syncs master toggle button */
                details.addEventListener("toggle", function () {
                    const badge = right.querySelector(".readme-summary-badge");
                    if (badge) {
                        badge.textContent = details.open ? "Collapse" : "Expand";
                    }
                    updateToggleAllBtnState();
                });

                details.appendChild(summary);
                details.appendChild(body);
                container.appendChild(details);
            });

            updateToggleAllBtnState();
        } catch (err) {
            /* Renders an error message with a retry button if the documentation request fails */
            container.innerHTML = `
                <div class="readme-error text-center p-5">
                    <i class="fa-solid fa-triangle-exclamation fa-2x text-warning mb-2"></i>
                    <p class="text-muted small mb-3">Could not load project documentation from server.</p>
                    <button type="button" class="btn btn-sm btn-outline-primary" id="readme-retry-btn">
                        <i class="fa-solid fa-rotate-right mr-1"></i> Retry
                    </button>
                </div>
            `;
            const retryBtn = document.getElementById("readme-retry-btn");
            if (retryBtn) {
                retryBtn.addEventListener("click", loadReadme);
            }
        }
    }

    /* Loads the documentation once the DOM has finished loading */
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", loadReadme);
    } else {
        loadReadme();
    }
})();
