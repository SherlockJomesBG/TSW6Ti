/* Here lies the JavaScript concerned with user preferences and UI settings */
/* This handles speed unit preferences, colour theme selection, custom accent colours and profile synchronization */
/* Remember consistency is key */

(function () {
    /* Local storage keys for interface preferences and valid speed unit definitions */
    const SPEED_UNIT_KEY = "tsw6ti_speed_unit";
    const THEME_KEY = "tsw6ti_theme";
    const ACCENT_KEY = "tsw6ti_accent_color";
    const VALID_UNITS = ["MPH", "KMH", "MS"];

    /* Timer reference for auto-dismissing settings saved alerts */
    let toastTimer = null;

    /* Triggers an alert confirming user settings have been saved */
    function showSavedToast() {
        if (window.TSWToast && typeof window.TSWToast.show === "function") {
            window.TSWToast.show("Settings saved", null, false);
            return;
        }
        const toast = document.getElementById("settings-toast");
        if (!toast) return;
        toast.hidden = false;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.hidden = true;
        }, 2000);
    }

    /* Shows or hides the dynamic livery explanation banner when follow-train theme is chosen */
    function syncFollowTrainBanner(themeValue) {
        const banner = document.getElementById("theme-follow-train-banner");
        if (banner) {
            banner.hidden = themeValue !== "follow-train";
        }
    }

    /* Synchronises accent color swatch selection with the currently active theme */
    function syncAccentRow(themeValue) {
        const accentRow = document.getElementById("setting-accent-row");
        if (!accentRow) return;

        const supports = window.TSWTheme && typeof window.TSWTheme.supportsAccent === "function"
            ? window.TSWTheme.supportsAccent(themeValue)
            : (themeValue === "light" || themeValue === "dark" || themeValue === "oled");

        accentRow.hidden = !supports;
        if (!supports) return;

        const activeAccent = ((window.TSWTheme && window.TSWTheme.getAccentColor)
            ? window.TSWTheme.getAccentColor(themeValue)
            : (localStorage.getItem(ACCENT_KEY) || "#3b82f6")).toLowerCase();

        let matchedPreset = false;
        accentRow.querySelectorAll(".settings-accent-swatch").forEach(function (btn) {
            const swatchHex = (btn.getAttribute("data-accent") || "").toLowerCase();
            const isMatch = swatchHex === activeAccent;
            if (isMatch) matchedPreset = true;
            btn.classList.toggle("is-active", isMatch);
            btn.setAttribute("aria-checked", String(isMatch));
        });

        const customInput = document.getElementById("setting-accent-custom");
        const customLabel = customInput ? customInput.closest(".settings-accent-custom") : null;
        if (customInput) {
            customInput.value = activeAccent;
        }
        if (customLabel) {
            customLabel.classList.toggle("is-active", !matchedPreset);
        }
    }

    /* Initialises all event listeners for settings controls (units, themes and swatches) */
    function initSettingsControls() {
        /* Speed unit selection dropdown */
        const unitSelect = document.getElementById("setting-speed-unit");
        if (unitSelect) {
            const savedUnit = localStorage.getItem(SPEED_UNIT_KEY);
            if (savedUnit && VALID_UNITS.includes(savedUnit)) {
                unitSelect.value = savedUnit;
            }
            if (unitSelect.dataset.bound !== "1") {
                unitSelect.dataset.bound = "1";
                unitSelect.addEventListener("change", function () {
                    const unit = unitSelect.value;
                    localStorage.setItem(SPEED_UNIT_KEY, unit);
                    window.dispatchEvent(new CustomEvent("tsw6:speedunit", { detail: { unit: unit } }));
                    showSavedToast();
                });
            }
        }

        /* Colour scheme theme dropdown */
        const themeSelect = document.getElementById("setting-theme");
        if (themeSelect) {
            const savedTheme = (window.TSWTheme && window.TSWTheme.getCurrent)
                ? window.TSWTheme.getCurrent()
                : (localStorage.getItem(THEME_KEY) || "default");
            themeSelect.value = savedTheme;
            syncFollowTrainBanner(savedTheme);
            syncAccentRow(savedTheme);

            if (themeSelect.dataset.bound !== "1") {
                themeSelect.dataset.bound = "1";
                themeSelect.addEventListener("change", async function () {
                    const chosenTheme = themeSelect.value;
                    syncFollowTrainBanner(chosenTheme);
                    syncAccentRow(chosenTheme);
                    if (window.TSWTheme && typeof window.TSWTheme.apply === "function") {
                        window.TSWTheme.apply(chosenTheme);
                    } else {
                        localStorage.setItem(THEME_KEY, chosenTheme);
                    }
                    if (window.TSWTheme && typeof window.TSWTheme.saveToConfig === "function") {
                        await window.TSWTheme.saveToConfig(chosenTheme);
                    }
                    showSavedToast();
                });

                window.addEventListener("tsw6:theme", function (e) {
                    const activeTheme = e.detail && e.detail.theme ? e.detail.theme : null;
                    if (activeTheme) {
                        if (themeSelect.value !== activeTheme) {
                            themeSelect.value = activeTheme;
                        }
                        syncFollowTrainBanner(activeTheme);
                        syncAccentRow(activeTheme);
                    }
                });
            }
        }

        /* Accent colour preset swatches and custom colour picker */
        const accentRow = document.getElementById("setting-accent-row");
        if (accentRow && accentRow.dataset.bound !== "1") {
            accentRow.dataset.bound = "1";

            accentRow.querySelectorAll(".settings-accent-swatch").forEach(function (btn) {
                btn.addEventListener("click", async function () {
                    const hex = btn.getAttribute("data-accent");
                    if (!hex) return;
                    if (window.TSWTheme && typeof window.TSWTheme.setAccentColor === "function") {
                        window.TSWTheme.setAccentColor(hex);
                    } else {
                        localStorage.setItem(ACCENT_KEY, hex);
                    }
                    const currentTheme = themeSelect ? themeSelect.value : "dark";
                    syncAccentRow(currentTheme);
                    if (window.TSWTheme && typeof window.TSWTheme.saveToConfig === "function") {
                        await window.TSWTheme.saveToConfig(currentTheme, hex);
                    }
                    showSavedToast();
                });
            });

            const customInput = document.getElementById("setting-accent-custom");
            if (customInput) {
                customInput.addEventListener("input", function () {
                    const hex = customInput.value;
                    if (window.TSWTheme && typeof window.TSWTheme.setAccentColor === "function") {
                        window.TSWTheme.setAccentColor(hex);
                    }
                    const currentTheme = themeSelect ? themeSelect.value : "dark";
                    syncAccentRow(currentTheme);
                });

                customInput.addEventListener("change", async function () {
                    const hex = customInput.value;
                    const currentTheme = themeSelect ? themeSelect.value : "dark";
                    if (window.TSWTheme && typeof window.TSWTheme.saveToConfig === "function") {
                        await window.TSWTheme.saveToConfig(currentTheme, hex);
                    }
                    showSavedToast();
                });
            }
        }
    }

    /* Exposes the settings controller module globally */
    window.TSWSettings = {
        init: initSettingsControls
    };

    /* Attaches initialization handler once the DOM has finished loading */
    document.addEventListener("DOMContentLoaded", initSettingsControls);
})();
