/* Here lies the JavaScript concerned with the Telemetry Guides page */
/* This handles markdown documentation fetching, parsing, sanitisation, image lightbox previews and guide switching */
/* Remember consistency is key */

(function () {
    "use strict";

    /* State holders for the guides catalogue, current guide slug and event binding flags */
    let guidesList = [];
    let activeSlug = null;
    let libraryEventsBound = false;

    /* Quick helper to query elements by their identifier */
    function qs(id) {
        return document.getElementById(id);
    }

    /* Sanitises string contents to prevent HTML injection */
    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    /* Strips YAML frontmatter headers from raw markdown strings */
    function stripFrontmatter(rawMarkdown) {
        const text = String(rawMarkdown || "").replace(/^\uFEFF/, "");
        const match = text.match(/^\s*---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
        if (match) {
            return text.slice(match[0].length).replace(/^[\r\n]+/, "");
        }
        return text;
    }

    /* Lightweight fallback parser to turn markdown into safe HTML when external libraries are unavailable */
    function fallbackMarkdownToHtml(markdown) {
        const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
        const out = [];
        let inCode = false;
        let codeLang = "";
        let listType = null;
        let inQuote = false;

        function closeList() {
            if (listType) {
                out.push(`</${listType}>`);
                listType = null;
            }
        }

        function closeQuote() {
            if (inQuote) {
                out.push("</blockquote>");
                inQuote = false;
            }
        }

        function formatInline(text) {
            let s = escapeHtml(text);
            s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (_, alt, url) {
                return `<img src="${escapeHtml(url.trim())}" alt="${escapeHtml(alt)}">`;
            });
            s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_, label, url) {
                return `<a href="${escapeHtml(url.trim())}">${label}</a>`;
            });
            s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
            s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
            s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
            return s;
        }

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.trim().startsWith("```")) {
                closeList();
                closeQuote();
                if (!inCode) {
                    inCode = true;
                    codeLang = line.trim().slice(3).trim();
                    out.push(`<pre><code${codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ""}>`);
                } else {
                    inCode = false;
                    out.push("</code></pre>");
                }
                continue;
            }

            if (inCode) {
                out.push(escapeHtml(line) + "\n");
                continue;
            }

            const trimmed = line.trim();
            if (!trimmed) {
                closeList();
                closeQuote();
                continue;
            }

            if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
                closeList();
                closeQuote();
                out.push("<hr>");
                continue;
            }

            const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (headingMatch) {
                closeList();
                closeQuote();
                const level = headingMatch[1].length;
                out.push(`<h${level}>${formatInline(headingMatch[2])}</h${level}>`);
                continue;
            }

            if (trimmed.startsWith(">")) {
                closeList();
                if (!inQuote) {
                    out.push("<blockquote>");
                    inQuote = true;
                }
                out.push(`<p>${formatInline(trimmed.replace(/^>\s?/, ""))}</p>`);
                continue;
            }
            closeQuote();

            const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
            if (ulMatch) {
                if (listType !== "ul") {
                    closeList();
                    listType = "ul";
                    out.push("<ul>");
                }
                out.push(`<li>${formatInline(ulMatch[1])}</li>`);
                continue;
            }

            const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
            if (olMatch) {
                if (listType !== "ol") {
                    closeList();
                    listType = "ol";
                    out.push("<ol>");
                }
                out.push(`<li>${formatInline(olMatch[1])}</li>`);
                continue;
            }

            closeList();
            out.push(`<p>${formatInline(trimmed)}</p>`);
        }

        if (inCode) out.push("</code></pre>");
        closeList();
        closeQuote();
        return out.join("\n");
    }

    /* Translates GitHub-style callouts into styled alert boxes */
    function applyGitHubAlerts(container) {
        const titles = {
            NOTE: "Note",
            TIP: "Tip",
            IMPORTANT: "Important",
            WARNING: "Warning",
            CAUTION: "Caution"
        };
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

    /* Parses markdown through marked and sanitises the output through DOMPurify */
    function renderMarkdownHtml(markdown) {
        const cleanMd = stripFrontmatter(markdown);
        let rawHtml;
        if (window.marked && typeof window.marked.parse === "function") {
            rawHtml = window.marked.parse(cleanMd);
        } else {
            rawHtml = fallbackMarkdownToHtml(cleanMd);
        }
        if (window.DOMPurify && typeof window.DOMPurify.sanitize === "function") {
            return window.DOMPurify.sanitize(rawHtml);
        }
        return rawHtml;
    }

    /* Converts relative image URLs within markdown guides to valid static asset paths */
    function resolveImageSource(rawSrc, relativeGuidePath) {
        const src = String(rawSrc || "").trim();
        if (!src) return "";
        if (/^(https?:|data:|blob:|\/)/i.test(src)) {
            return src;
        }
        const dirParts = String(relativeGuidePath || "").split("/");
        dirParts.pop();
        const basePath = "/Assets/Guides/" + (dirParts.length ? dirParts.join("/") + "/" : "");
        return basePath + src.replace(/^\.\//, "");
    }

    /* Scrolls the view pane smoothly to the top of the guide */
    function scrollPageToTop() {
        const workspace = document.getElementById("telem-workspace") || document.querySelector(".telem-workspace");
        if (workspace && typeof workspace.scrollTo === "function") {
            workspace.scrollTo({ top: 0, behavior: "auto" });
        }
        window.scrollTo({ top: 0, behavior: "auto" });
    }

    /* Displays high-resolution screenshots in an interactive lightbox popup */
    function openLightbox(src, caption) {
        const modal = qs("guides-lightbox");
        const img = qs("guides-lightbox-img");
        const capEl = qs("guides-lightbox-caption");
        if (!modal || !img || !src) return;

        img.src = src;
        img.alt = caption || "Guide image";
        if (capEl) capEl.textContent = caption || "Guide Image";
        modal.hidden = false;
    }

    /* Closes the open image preview lightbox modal */
    function closeLightbox() {
        const modal = qs("guides-lightbox");
        const img = qs("guides-lightbox-img");
        if (modal) modal.hidden = true;
        if (img) img.removeAttribute("src");
    }

    /* Enhances images within guide articles with captions, fallbacks and click-to-zoom */
    function prepareArticleImages(container, relativeGuidePath) {
        const imgs = Array.from(container.querySelectorAll("img"));
        imgs.forEach(function (img, idx) {
            const rawSrc = img.getAttribute("src") || "";
            const resolvedSrc = resolveImageSource(rawSrc, relativeGuidePath);
            if (resolvedSrc && resolvedSrc !== rawSrc) {
                img.setAttribute("src", resolvedSrc);
            }

            const alt = (img.getAttribute("alt") || "").trim() || `Image ${idx + 1}`;

            const figure = document.createElement("figure");
            figure.className = "guide-inline-figure";

            const parent = img.parentElement;
            if (parent && parent.tagName === "P" && parent.childNodes.length === 1) {
                parent.replaceWith(figure);
            } else {
                img.replaceWith(figure);
            }
            figure.appendChild(img);

            const fallback = document.createElement("div");
            fallback.className = "guide-inline-fallback";
            fallback.innerHTML =
                `<i class="fa-regular fa-image" aria-hidden="true"></i>` +
                `<span>${escapeHtml(alt)}</span>` +
                `<code>${escapeHtml(resolvedSrc)}</code>`;
            figure.appendChild(fallback);

            if (alt) {
                const cap = document.createElement("figcaption");
                cap.className = "guide-inline-caption";
                cap.textContent = alt;
                figure.appendChild(cap);
            }

            let broken = false;

            img.addEventListener("click", function () {
                if (!broken) openLightbox(resolvedSrc, alt);
            });

            img.addEventListener("load", function () {
                broken = false;
                img.classList.remove("is-broken-img");
                figure.classList.remove("is-broken");
            });

            img.addEventListener("error", function () {
                broken = true;
                img.classList.add("is-broken-img");
                figure.classList.add("is-broken");
            });

            if (img.complete && img.naturalWidth === 0) {
                broken = true;
                img.classList.add("is-broken-img");
                figure.classList.add("is-broken");
            }
        });
    }

    /* Renders guide cards in a searchable grid */
    function renderGuidesLibrary(filterText) {
        const grid = qs("guides-cards-grid");
        const statusEl = qs("guides-list-status");
        if (!grid || !statusEl) return;

        const query = String(filterText || "").trim().toLowerCase();
        const filtered = guidesList.filter(function (g) {
            if (!query) return true;
            return (
                String(g.title || "").toLowerCase().includes(query) ||
                String(g.fileName || "").toLowerCase().includes(query) ||
                String(g.slug || "").toLowerCase().includes(query) ||
                String(g.summary || "").toLowerCase().includes(query)
            );
        });

        grid.innerHTML = "";
        if (!guidesList.length) {
            statusEl.textContent = "No markdown guides were found in Assets/Guides.";
            statusEl.hidden = false;
            return;
        }

        if (!filtered.length) {
            statusEl.textContent = `No guides match "${filterText}".`;
            statusEl.hidden = false;
            return;
        }

        statusEl.hidden = true;
        filtered.forEach(function (guide) {
            const card = document.createElement("button");
            card.type = "button";
            card.className = "guide-card";

            const imageLabel = guide.imageCount === 1 ? "1 image" : `${guide.imageCount} images`;
            const readLabel = `${guide.readMinutes || 1} min read`;

            card.innerHTML =
                `<div>` +
                `  <div class="guide-card-top">` +
                `    <span class="guide-card-icon"><i class="fa-solid fa-book-open"></i></span>` +
                `    <span class="guide-card-file" title="${escapeHtml(guide.relativePath)}">${escapeHtml(guide.fileName)}</span>` +
                `  </div>` +
                `  <h2 class="guide-card-title">${escapeHtml(guide.title)}</h2>` +
                `  <p class="guide-card-summary">${escapeHtml(guide.summary || "Open guide to view full documentation.")}</p>` +
                `</div>` +
                `<div class="guide-card-footer">` +
                `  <div class="guide-card-stats">` +
                `    <span><i class="fa-regular fa-clock"></i>${escapeHtml(readLabel)}</span>` +
                `    <span><i class="fa-regular fa-images"></i>${escapeHtml(imageLabel)}</span>` +
                `  </div>` +
                `  <span class="guide-card-cta">Read Guide <i class="fa-solid fa-chevron-right"></i></span>` +
                `</div>`;

            card.addEventListener("click", function () {
                openGuide(guide.slug, true);
            });
            grid.appendChild(card);
        });
    }

    /* Updates the quick-switch dropdown menu for switching between guides */
    function populateGuideSwitcher(selectedSlug) {
        const select = qs("guides-switcher-select");
        if (!select) return;
        select.innerHTML = "";
        guidesList.forEach(function (g) {
            const opt = document.createElement("option");
            opt.value = g.slug;
            opt.textContent = g.title;
            if (g.slug.toLowerCase() === String(selectedSlug || "").toLowerCase()) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });
    }

    /* Queries the server API for the full list of markdown guides */
    async function fetchGuidesList() {
        const statusEl = qs("guides-list-status");
        if (statusEl) {
            statusEl.textContent = "Loading available guides...";
            statusEl.hidden = false;
        }
        try {
            const res = await fetch("/api/guides", { cache: "no-store" });
            const data = await res.json();
            if (!res.ok || data.status !== "success") {
                throw new Error(data.message || "Failed to scan guides.");
            }
            guidesList = Array.isArray(data.guides) ? data.guides : [];
            const search = qs("guides-search-input");
            renderGuidesLibrary(search ? search.value : "");
        } catch (err) {
            guidesList = [];
            if (statusEl) {
                statusEl.textContent = err.message || "Could not load guides from server.";
                statusEl.hidden = false;
            }
        }
    }

    /* Displays the library catalogue and hides the article reader */
    function showLibraryView(pushHistory) {
        activeSlug = null;
        closeLightbox();

        const libView = qs("guides-library-view");
        const readerView = qs("guides-reader-view");
        if (libView) libView.hidden = false;
        if (readerView) readerView.hidden = true;

        if (pushHistory && window.location.pathname + window.location.search !== "/guides") {
            window.history.pushState({}, "", "/guides");
        }
        document.title = "TSW6 — Guides";
        scrollPageToTop();
    }

    /* Fetches, formats and displays a specific guide article */
    async function openGuide(slug, pushHistory) {
        if (!slug) {
            showLibraryView(pushHistory);
            return;
        }

        if (!guidesList.length) {
            await fetchGuidesList();
        }

        const libView = qs("guides-library-view");
        const readerView = qs("guides-reader-view");
        const titleEl = qs("guides-active-title");
        const subEl = qs("guides-active-subtitle");
        const bodyEl = qs("guides-article-body");

        if (libView) libView.hidden = true;
        if (readerView) readerView.hidden = false;
        if (bodyEl) {
            bodyEl.innerHTML = `<p style="color: var(--text-muted);">Loading guide...</p>`;
        }

        if (pushHistory) {
            const targetUrl = `/guides?guide=${encodeURIComponent(slug)}`;
            if (window.location.pathname + window.location.search !== targetUrl) {
                window.history.pushState({}, "", targetUrl);
            }
        }

        try {
            const encodedSlug = slug.split("/").map(encodeURIComponent).join("/");
            const res = await fetch(`/api/guides/${encodedSlug}`, { cache: "no-store" });
            const data = await res.json();
            if (!res.ok || data.status !== "success" || !data.guide) {
                throw new Error(data.message || "Guide not found.");
            }

            const guide = data.guide;
            activeSlug = guide.slug;
            document.title = `TSW6 — ${guide.title}`;

            if (titleEl) titleEl.textContent = guide.title;
            if (subEl) {
                const imgCount = guide.imageCount === 1 ? "1 image" : `${guide.imageCount} images`;
                subEl.textContent = `${guide.fileName} • ${guide.readMinutes} min read • ${imgCount}`;
            }

            populateGuideSwitcher(guide.slug);

            if (bodyEl) {
                bodyEl.innerHTML = renderMarkdownHtml(guide.markdown || "");
                applyGitHubAlerts(bodyEl);
                prepareArticleImages(bodyEl, guide.relativePath);
            }

            scrollPageToTop();
        } catch (err) {
            if (titleEl) titleEl.textContent = "Guide Error";
            if (subEl) subEl.textContent = slug;
            if (bodyEl) {
                bodyEl.innerHTML = `<p>${escapeHtml(err.message || "Failed to load guide.")}</p>`;
            }
        }
    }

    /* Binds search inputs, navigation buttons and lightbox shortcut events */
    function bindEvents() {
        if (libraryEventsBound) return;
        libraryEventsBound = true;

        const searchInput = qs("guides-search-input");
        if (searchInput) {
            searchInput.addEventListener("input", function () {
                renderGuidesLibrary(searchInput.value);
            });
        }

        const refreshBtn = qs("guides-refresh-btn");
        if (refreshBtn) {
            refreshBtn.addEventListener("click", function () {
                fetchGuidesList();
            });
        }

        const backBtn = qs("guides-back-btn");
        if (backBtn) {
            backBtn.addEventListener("click", function () {
                showLibraryView(true);
            });
        }

        const switcher = qs("guides-switcher-select");
        if (switcher) {
            switcher.addEventListener("change", function () {
                if (switcher.value) {
                    openGuide(switcher.value, true);
                }
            });
        }

        const closeBtn = qs("guides-lightbox-close");
        const backdrop = document.querySelector("#guides-lightbox .guides-lightbox-backdrop");
        if (closeBtn) closeBtn.addEventListener("click", closeLightbox);
        if (backdrop) backdrop.addEventListener("click", closeLightbox);

        document.addEventListener("keydown", function (event) {
            const modal = qs("guides-lightbox");
            if (event.key === "Escape" && modal && !modal.hidden) {
                closeLightbox();
            }
        });
    }

    /* Extracts the requested guide slug from URL parameters or path segments */
    function getRequestedGuideFromLocation() {
        const url = new URL(window.location.href);
        const q = url.searchParams.get("guide");
        if (q) return q;
        if (url.pathname.startsWith("/guides/")) {
            return decodeURIComponent(url.pathname.slice("/guides/".length)).replace(/\/+$/, "");
        }
        return null;
    }

    /* Initialises the guides interface on initial entry */
    async function init() {
        const wrapper = qs("guides-wrapper");
        if (!wrapper) return;
        bindEvents();
        await fetchGuidesList();

        const requested = getRequestedGuideFromLocation();
        if (requested) {
            await openGuide(requested, false);
        } else {
            showLibraryView(false);
        }
    }

    /* Handles navigation events when switching to the guides tab */
    async function onShow(guideSlug) {
        bindEvents();
        if (!guidesList.length) {
            await fetchGuidesList();
        }
        const target = guideSlug !== undefined ? guideSlug : getRequestedGuideFromLocation();
        if (target) {
            if (target !== activeSlug) {
                await openGuide(target, false);
            } else {
                const libView = qs("guides-library-view");
                const readerView = qs("guides-reader-view");
                if (libView) libView.hidden = true;
                if (readerView) readerView.hidden = false;
            }
        } else {
            showLibraryView(false);
            await fetchGuidesList();
        }
    }

    /* Exposes the guides controller globally */
    window.TSWGuides = {
        init: init,
        onShow: onShow,
        openGuide: openGuide
    };

    /* Boots the guides interface when the DOM is ready */
    document.addEventListener("DOMContentLoaded", function () {
        if (
            window.location.pathname === "/guides" ||
            window.location.pathname === "/guides.html" ||
            window.location.pathname.startsWith("/guides/")
        ) {
            init();
        }
    });
})();
