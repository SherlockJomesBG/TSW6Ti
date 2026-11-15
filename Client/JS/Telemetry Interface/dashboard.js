/* Here lies the JavaScript concerned with the live Telemetry Dashboard */
/* This handles grid layouts, drag-and-drop customization, widget mounting, GPS route tracking and high-frequency game telemetry polling */
/* Remember consistency is key */

(function () {
    /* Constant storage keys, grid dimensions, valid tile sizes and telemetry poll intervals */
    const TOKEN_KEY = "tsw6ti_session_token";
    const SPEED_UNIT_KEY = "tsw6ti_speed_unit";
    const TELEM_STATE_KEY = "tsw6ti_telemetry_state";
    const GRID_COLS = 5;
    const GRID_ROWS = 3;
    const VALID_SIZES = ["1x1", "2x1", "1x2", "2x2", "5x1"];
    const MAX_HISTORY = 60;
    const TELEMETRY_POLL_MS = 1000;

    /* Master catalogue of available telemetry dashboard modules and widgets */
    const MODULE_CATALOG = [
        { id: "route", title: "Route & Position", defaultSize: "5x1", desc: "Automatic route detection, travel direction, next station, and distance to station." },
        { id: "velocity", title: "Velocity Gauge", defaultSize: "1x2", desc: "Circular speedometer arc gauge, speed limit marker, and overspeed warning." },
        { id: "dynamics", title: "Dynamics", defaultSize: "1x2", desc: "Real-time acceleration readout, power/brake force bar, and traction state." },
        { id: "speed-trace", title: "Speed Trace (60s)", defaultSize: "2x1", desc: "Rolling 60-second line chart of train speed against track speed limit." },
        { id: "speed-limit", title: "Speed vs Limit", defaultSize: "1x1", desc: "Bar comparison of current speed to limit with headroom calculation." },
        { id: "weather", title: "Environment Controls", defaultSize: "2x1", desc: "Live weather conditions with click-to-cycle environment controls." },
        { id: "stats", title: "Session Statistics", defaultSize: "2x1", desc: "Top speed, average speed, peak acceleration, peak braking, and overspeeds." },
        { id: "accel-trace", title: "Accel Trace (60s)", defaultSize: "2x1", desc: "Rolling 60-second line chart of train acceleration and deceleration." },
        { id: "cruise", title: "Cruise Control", defaultSize: "1x1", desc: "Live throttle/brake percentages and automated speed-limit cruise control." }
    ];

    /* Default module arrangement for initial 5x3 dashboard layout */
    const DEFAULT_MODULES = [
        { id: "velocity", size: "1x2", col: 1, row: 1 },
        { id: "dynamics", size: "1x2", col: 2, row: 1 },
        { id: "speed-trace", size: "2x1", col: 3, row: 1 },
        { id: "speed-limit", size: "1x1", col: 5, row: 1 },
        { id: "weather", size: "2x1", col: 3, row: 2 },
        { id: "route", size: "1x1", col: 5, row: 2 },
        { id: "stats", size: "2x1", col: 1, row: 3 },
        { id: "accel-trace", size: "2x1", col: 3, row: 3 },
        { id: "cruise", size: "1x1", col: 5, row: 3 }
    ];

    /* Registry maps and template caches for active module controllers */
    const registeredControllers = {};
    const moduleTemplateCache = {};
    const activeInstances = {};

    /* Layout state variables, edit mode toggles and loaded routes database */
    let currentLayout = [];
    let savedLayoutSnapshot = [];
    let isEditMode = false;
    let draggingModuleId = null;
    let routesCatalog = [];

    /* Stateful tracker keeping track of current route progress, segment indices and train travel direction */
    const routeTracker = {
        routeID: null,
        segmentIdx: null,
        direction: null,
        anchorLat: null,
        anchorLon: null,
        anchorDistA: null,
        anchorDistB: null
    };

    /* Master telemetry state containing active speeds, forces, GPS fixes, histories and statistics */
    const telemetryState = {
        speedMph: 0,
        limitMph: 0,
        speed: 0,
        speedLimit: 0,
        speedUnit: localStorage.getItem(SPEED_UNIT_KEY) || "MPH",
        unitLabel: "mph",
        maxGaugeSpeed: 140,
        acceleration: 0,
        trainName: "Unknown",
        dateTime: "",
        coordinates: null,
        lastCoordinates: null,
        distanceMeters: 0,
        route: null,
        throttle: null,
        brake: null,
        reverser: null,
        weather: null,
        speedHistory: Array(MAX_HISTORY).fill(0),
        limitHistory: Array(MAX_HISTORY).fill(0),
        accelHistory: Array(MAX_HISTORY).fill(0),
        timeLabels: Array(MAX_HISTORY).fill(""),
        topSpeed: 0,
        avgSpeed: 0,
        peakAccel: 0,
        peakBrake: 0,
        overspeedCount: 0,
        wasOverspeed: false,
        cruiseEnabled: false
    };

    /* Restores accumulated session stats and history arrays from session storage */
    function restoreSessionTelemetry() {
        try {
            const raw = sessionStorage.getItem(TELEM_STATE_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (!saved || typeof saved !== "object") return;

            if (typeof saved.topSpeed === "number") telemetryState.topSpeed = saved.topSpeed;
            if (typeof saved.avgSpeed === "number") telemetryState.avgSpeed = saved.avgSpeed;
            if (typeof saved.peakAccel === "number") telemetryState.peakAccel = saved.peakAccel;
            if (typeof saved.peakBrake === "number") telemetryState.peakBrake = saved.peakBrake;
            if (typeof saved.overspeedCount === "number") telemetryState.overspeedCount = saved.overspeedCount;
            if (typeof saved.wasOverspeed === "boolean") telemetryState.wasOverspeed = saved.wasOverspeed;
            if (typeof saved.distanceMeters === "number") telemetryState.distanceMeters = saved.distanceMeters;
            if (typeof saved.cruiseEnabled === "boolean") telemetryState.cruiseEnabled = saved.cruiseEnabled;
            if (saved.lastCoordinates) telemetryState.lastCoordinates = saved.lastCoordinates;
            if (saved.route) telemetryState.route = saved.route;

            if (Array.isArray(saved.speedHistory) && saved.speedHistory.length === MAX_HISTORY) {
                telemetryState.speedHistory = saved.speedHistory;
            }
            if (Array.isArray(saved.limitHistory) && saved.limitHistory.length === MAX_HISTORY) {
                telemetryState.limitHistory = saved.limitHistory;
            }
            if (Array.isArray(saved.accelHistory) && saved.accelHistory.length === MAX_HISTORY) {
                telemetryState.accelHistory = saved.accelHistory;
            }
            if (Array.isArray(saved.timeLabels) && saved.timeLabels.length === MAX_HISTORY) {
                telemetryState.timeLabels = saved.timeLabels;
            }
            if (saved.routeTracker && typeof saved.routeTracker === "object") {
                Object.assign(routeTracker, saved.routeTracker);
            }
        } catch (err) {
        }
    }

    /* Persists live session statistics into session storage */
    function persistSessionTelemetry() {
        try {
            sessionStorage.setItem(TELEM_STATE_KEY, JSON.stringify({
                topSpeed: telemetryState.topSpeed,
                avgSpeed: telemetryState.avgSpeed,
                peakAccel: telemetryState.peakAccel,
                peakBrake: telemetryState.peakBrake,
                overspeedCount: telemetryState.overspeedCount,
                wasOverspeed: telemetryState.wasOverspeed,
                distanceMeters: telemetryState.distanceMeters,
                cruiseEnabled: telemetryState.cruiseEnabled,
                lastCoordinates: telemetryState.lastCoordinates,
                route: telemetryState.route,
                speedHistory: telemetryState.speedHistory,
                limitHistory: telemetryState.limitHistory,
                accelHistory: telemetryState.accelHistory,
                timeLabels: telemetryState.timeLabels,
                routeTracker: routeTracker
            }));
        } catch (err) {
        }
    }

    /* Parses width and height dimension integers from size strings like "2x1" */
    function parseSize(sizeStr) {
        const parts = String(sizeStr || "1x1").split("x");
        return {
            w: Math.max(1, Math.min(GRID_COLS, parseInt(parts[0], 10) || 1)),
            h: Math.max(1, Math.min(GRID_ROWS, parseInt(parts[1], 10) || 1))
        };
    }

    /* Deep clones layout module arrays */
    function cloneLayout(list) {
        return JSON.parse(JSON.stringify(list));
    }

    /* Constructs authorization headers with stored bearer token */
    function authHeaders(extra) {
        return Object.assign(
            { Authorization: "Bearer " + localStorage.getItem(TOKEN_KEY) },
            extra
        );
    }

    /* Synchronises unit multipliers and gauge ceilings based on user's speed unit preference */
    function syncUnitMultipliers() {
        const unit = localStorage.getItem(SPEED_UNIT_KEY) || "MPH";
        telemetryState.speedUnit = unit;
        if (unit === "KMH") {
            telemetryState.unitLabel = "km/h";
            telemetryState.maxGaugeSpeed = 225;
        } else if (unit === "MS") {
            telemetryState.unitLabel = "m/s";
            telemetryState.maxGaugeSpeed = 65;
        } else {
            telemetryState.unitLabel = "mph";
            telemetryState.maxGaugeSpeed = 140;
        }
    }

    /* Converts speeds from mph into the chosen user preference unit */
    function convertMph(mph) {
        if (telemetryState.speedUnit === "KMH") return mph * 1.609344;
        if (telemetryState.speedUnit === "MS") return mph / 2.236936;
        return mph;
    }

    /* Builds a 2D matrix of occupied grid cells to prevent tile collisions */
    function buildOccupancyGrid(modules, ignoreModuleId) {
        const grid = Array.from({ length: GRID_ROWS }, function () {
            return Array(GRID_COLS).fill(null);
        });
        modules.forEach(function (m) {
            if (m.id === ignoreModuleId) return;
            const dim = parseSize(m.size);
            for (let r = m.row; r < m.row + dim.h; r++) {
                for (let c = m.col; c < m.col + dim.w; c++) {
                    if (r >= 1 && r <= GRID_ROWS && c >= 1 && c <= GRID_COLS) {
                        grid[r - 1][c - 1] = m.id;
                    }
                }
            }
        });
        return grid;
    }

    /* Checks whether a module of a given size can fit at a specific column and row */
    function canPlaceAt(modules, ignoreModuleId, col, row, sizeStr) {
        const dim = parseSize(sizeStr);
        if (col < 1 || row < 1 || col + dim.w - 1 > GRID_COLS || row + dim.h - 1 > GRID_ROWS) {
            return false;
        }
        const grid = buildOccupancyGrid(modules, ignoreModuleId);
        for (let r = row; r < row + dim.h; r++) {
            for (let c = col; c < col + dim.w; c++) {
                if (grid[r - 1][c - 1] !== null) {
                    return false;
                }
            }
        }
        return true;
    }

    /* Finds the first unoccupied grid cell matching the required tile dimensions */
    function findFirstPlacement(modules, ignoreModuleId, sizeStr) {
        for (let r = 1; r <= GRID_ROWS; r++) {
            for (let c = 1; c <= GRID_COLS; c++) {
                if (canPlaceAt(modules, ignoreModuleId, c, r, sizeStr)) {
                    return { col: c, row: r };
                }
            }
        }
        return null;
    }

    /* Fetches HTML template markup for a given module identifier */
    async function fetchModuleTemplate(moduleId) {
        if (moduleTemplateCache[moduleId]) {
            return moduleTemplateCache[moduleId];
        }
        const url = `/Client/HTML/Telemetry Interface/Modules/${encodeURIComponent(moduleId)}.html`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to load module ${moduleId}`);
        const html = await response.text();
        moduleTemplateCache[moduleId] = html;
        return html;
    }

    /* Retrieves metadata from the master module catalogue */
    function getCatalogMeta(moduleId) {
        return MODULE_CATALOG.find(function (m) { return m.id === moduleId; }) || {
            id: moduleId,
            title: moduleId,
            defaultSize: "1x1",
            desc: ""
        };
    }

    /* Applies CSS grid-column and grid-row positioning rules to a module slot element */
    function applySlotGridPosition(slotEl, mod) {
        const dim = parseSize(mod.size);
        slotEl.setAttribute("data-size", mod.size);
        slotEl.style.gridColumn = `${mod.col} / span ${dim.w}`;
        slotEl.style.gridRow = `${mod.row} / span ${dim.h}`;

        slotEl.querySelectorAll(".module-size-btn").forEach(function (btn) {
            btn.classList.toggle("is-active", btn.getAttribute("data-size-opt") === mod.size);
        });
    }

    /* Mounts a module slot into the dashboard grid with drag handles, resize buttons and removal controls */
    async function mountModuleSlot(mod) {
        const gridEl = document.getElementById("dashboard-grid");
        if (!gridEl) return;

        const meta = getCatalogMeta(mod.id);
        const slot = document.createElement("section");
        slot.className = "module-slot";
        slot.setAttribute("data-module", mod.id);

        /* Edit mode toolbar with title handle, resize options and delete action */
        const toolbar = document.createElement("div");
        toolbar.className = "module-edit-toolbar";
        toolbar.draggable = true;

        const handle = document.createElement("div");
        handle.className = "module-drag-handle";
        handle.innerHTML = `<i class="fa-solid fa-grip-vertical"></i><span>${meta.title}</span>`;

        const controls = document.createElement("div");
        controls.className = "module-edit-controls";

        VALID_SIZES.forEach(function (sz) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "module-size-btn" + (sz === mod.size ? " is-active" : "");
            btn.setAttribute("data-size-opt", sz);
            btn.textContent = sz;
            btn.title = `Resize to ${sz}`;
            btn.addEventListener("click", function (e) {
                e.stopPropagation();
                handleResizeModule(mod.id, sz);
            });
            controls.appendChild(btn);
        });

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "module-remove-btn";
        removeBtn.title = "Remove module";
        removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        removeBtn.addEventListener("click", function (e) {
            e.stopPropagation();
            handleRemoveModule(mod.id);
        });
        controls.appendChild(removeBtn);

        toolbar.appendChild(handle);
        toolbar.appendChild(controls);

        toolbar.addEventListener("dragstart", function (e) {
            if (!isEditMode) {
                e.preventDefault();
                return;
            }
            draggingModuleId = mod.id;
            slot.classList.add("is-dragging");
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", mod.id);
            }
        });

        toolbar.addEventListener("dragend", function () {
            draggingModuleId = null;
            slot.classList.remove("is-dragging");
            clearCellHighlights();
        });

        slot.addEventListener("dragover", function (e) {
            if (!isEditMode || !draggingModuleId || draggingModuleId === mod.id) return;
            e.preventDefault();
        });

        slot.addEventListener("drop", function (e) {
            if (!isEditMode || !draggingModuleId || draggingModuleId === mod.id) return;
            e.preventDefault();
            const dragged = currentLayout.find(function (m) { return m.id === draggingModuleId; });
            const target = currentLayout.find(function (m) { return m.id === mod.id; });
            if (!dragged || !target) return;

            if (dragged.size === target.size) {
                const tmpCol = dragged.col;
                const tmpRow = dragged.row;
                dragged.col = target.col;
                dragged.row = target.row;
                target.col = tmpCol;
                target.row = tmpRow;
                applySlotGridPosition(activeInstances[dragged.id].slotEl, dragged);
                applySlotGridPosition(activeInstances[target.id].slotEl, target);
            } else if (canPlaceAt(currentLayout, dragged.id, target.col, target.row, dragged.size)) {
                dragged.col = target.col;
                dragged.row = target.row;
                applySlotGridPosition(activeInstances[dragged.id].slotEl, dragged);
            }
            clearCellHighlights();
        });

        const body = document.createElement("div");
        body.className = "module-body";

        slot.appendChild(toolbar);
        slot.appendChild(body);
        applySlotGridPosition(slot, mod);
        gridEl.appendChild(slot);

        activeInstances[mod.id] = { slotEl: slot, bodyEl: body };
        await hydrateModuleBody(mod, body, telemetryState);
    }

    /* Hydrates a module slot's inner HTML, injects scoped styles, executes controllers and triggers updates */
    async function hydrateModuleBody(mod, bodyEl, stateObj) {
        const meta = getCatalogMeta(mod.id);
        try {
            const rawHtml = await fetchModuleTemplate(mod.id);
            const temp = document.createElement("div");
            temp.innerHTML = rawHtml;

            const styleEl = temp.querySelector("style");
            if (styleEl && !document.getElementById("mod-style-" + mod.id)) {
                const clonedStyle = document.createElement("style");
                clonedStyle.id = "mod-style-" + mod.id;
                clonedStyle.textContent = styleEl.textContent;
                document.head.appendChild(clonedStyle);
            }
            if (styleEl) styleEl.remove();

            const scriptEl = temp.querySelector("script");
            const scriptCode = scriptEl ? scriptEl.textContent : "";
            if (scriptEl) scriptEl.remove();

            bodyEl.innerHTML = temp.innerHTML;

            if (scriptCode && !registeredControllers[mod.id]) {
                const execScript = document.createElement("script");
                execScript.textContent = scriptCode;
                document.head.appendChild(execScript);
                execScript.remove();
            }

            const ctrl = registeredControllers[mod.id];
            if (ctrl) {
                if (typeof ctrl.init === "function") {
                    ctrl.init(bodyEl, stateObj, mod.size);
                }
                if (typeof ctrl.update === "function") {
                    ctrl.update(bodyEl, stateObj, mod.size);
                }
            }
        } catch (err) {
            bodyEl.innerHTML = `<div class="mod-eyebrow">${meta.title}</div><p class="text-muted small mb-0">Failed to load module.</p>`;
        }
    }

    /* Completely tears down and re-renders all mounted dashboard widgets */
    async function renderFullGrid() {
        Object.keys(activeInstances).forEach(function (id) {
            const ctrl = registeredControllers[id];
            const inst = activeInstances[id];
            if (ctrl && typeof ctrl.destroy === "function" && inst) {
                ctrl.destroy(inst.bodyEl);
            }
            if (inst && inst.slotEl) {
                inst.slotEl.remove();
            }
            delete activeInstances[id];
        });

        for (let i = 0; i < currentLayout.length; i++) {
            await mountModuleSlot(currentLayout[i]);
        }
    }

    /* Updates user feedback hints inside the edit mode toolbar banner */
    function setEditHint(msg, isError) {
        const hintEl = document.getElementById("dash-edit-hint");
        if (!hintEl) return;
        hintEl.textContent = msg;
        hintEl.classList.toggle("is-error", Boolean(isError));
    }

    /* Handles resizing a module and finds open grid positions if collision occurs */
    function handleResizeModule(moduleId, newSize) {
        if (!VALID_SIZES.includes(newSize)) return;
        const mod = currentLayout.find(function (m) { return m.id === moduleId; });
        if (!mod || mod.size === newSize) return;

        const dim = parseSize(newSize);
        let targetCol = Math.min(mod.col, GRID_COLS - dim.w + 1);
        let targetRow = Math.min(mod.row, GRID_ROWS - dim.h + 1);

        if (!canPlaceAt(currentLayout, moduleId, targetCol, targetRow, newSize)) {
            const alt = findFirstPlacement(currentLayout, moduleId, newSize);
            if (!alt) {
                setEditHint(`Not enough open space on the 5×3 grid for ${newSize}. Move or remove another module first.`, true);
                return;
            }
            targetCol = alt.col;
            targetRow = alt.row;
        }

        mod.size = newSize;
        mod.col = targetCol;
        mod.row = targetRow;

        const inst = activeInstances[moduleId];
        if (inst) {
            applySlotGridPosition(inst.slotEl, mod);
            const ctrl = registeredControllers[moduleId];
            if (ctrl && typeof ctrl.resize === "function") {
                setTimeout(function () {
                    ctrl.resize(inst.bodyEl, newSize, telemetryState);
                }, 50);
            }
        }
        setEditHint("Drag modules to empty cells or swap them, choose a size (1×1, 2×1, 1×2, 2×2, 5×1), or add/remove widgets.", false);
    }

    /* Removes a module from the dashboard layout */
    function handleRemoveModule(moduleId) {
        const idx = currentLayout.findIndex(function (m) { return m.id === moduleId; });
        if (idx === -1) return;
        currentLayout.splice(idx, 1);

        const inst = activeInstances[moduleId];
        const ctrl = registeredControllers[moduleId];
        if (ctrl && typeof ctrl.destroy === "function" && inst) {
            ctrl.destroy(inst.bodyEl);
        }
        if (inst && inst.slotEl) {
            inst.slotEl.remove();
        }
        delete activeInstances[moduleId];
    }

    /* Adds a new module from the catalogue into the first available grid space */
    async function handleAddModule(moduleId) {
        if (currentLayout.some(function (m) { return m.id === moduleId; })) return;
        const meta = getCatalogMeta(moduleId);
        const preferredSizes = [meta.defaultSize, "1x1", "2x1", "1x2", "2x2", "5x1"];
        let chosenSize = null;
        let pos = null;

        for (let i = 0; i < preferredSizes.length; i++) {
            const sz = preferredSizes[i];
            const found = findFirstPlacement(currentLayout, null, sz);
            if (found) {
                chosenSize = sz;
                pos = found;
                break;
            }
        }

        if (!pos) {
            setEditHint("The 5×3 grid is currently full. Remove or shrink a module to add another.", true);
            closeAddModuleModal();
            return;
        }

        const newMod = { id: moduleId, size: chosenSize, col: pos.col, row: pos.row };
        currentLayout.push(newMod);
        await mountModuleSlot(newMod);
        closeAddModuleModal();
    }

    /* Constructs invisible drag-and-drop target cells across the 5x3 grid */
    function buildBackgroundDropCells() {
        const container = document.getElementById("dashboard-grid-cells");
        if (!container) return;
        container.innerHTML = "";

        for (let r = 1; r <= GRID_ROWS; r++) {
            for (let c = 1; c <= GRID_COLS; c++) {
                const cell = document.createElement("div");
                cell.className = "dash-grid-cell";
                cell.setAttribute("data-col", String(c));
                cell.setAttribute("data-row", String(r));
                cell.textContent = `${c},${r}`;

                cell.addEventListener("dragover", function (e) {
                    if (!isEditMode || !draggingModuleId) return;
                    e.preventDefault();
                    highlightDropFootprint(c, r);
                });

                cell.addEventListener("drop", function (e) {
                    if (!isEditMode || !draggingModuleId) return;
                    e.preventDefault();
                    const mod = currentLayout.find(function (m) { return m.id === draggingModuleId; });
                    if (!mod) return;
                    const dim = parseSize(mod.size);
                    const clampedCol = Math.min(c, GRID_COLS - dim.w + 1);
                    const clampedRow = Math.min(r, GRID_ROWS - dim.h + 1);

                    if (canPlaceAt(currentLayout, mod.id, clampedCol, clampedRow, mod.size)) {
                        mod.col = clampedCol;
                        mod.row = clampedRow;
                        if (activeInstances[mod.id]) {
                            applySlotGridPosition(activeInstances[mod.id].slotEl, mod);
                        }
                    } else {
                        setEditHint("Cannot place module there — cells are occupied by another module.", true);
                    }
                    clearCellHighlights();
                });

                container.appendChild(cell);
            }
        }
    }

    /* Clears hover highlight classes from grid background cells */
    function clearCellHighlights() {
        document.querySelectorAll(".dash-grid-cell").forEach(function (cell) {
            cell.classList.remove("is-drop-valid", "is-drop-invalid");
        });
    }

    /* Highlights the drop footprint beneath the dragged module indicating validity */
    function highlightDropFootprint(col, row) {
        clearCellHighlights();
        const mod = currentLayout.find(function (m) { return m.id === draggingModuleId; });
        if (!mod) return;
        const dim = parseSize(mod.size);
        const startCol = Math.min(col, GRID_COLS - dim.w + 1);
        const startRow = Math.min(row, GRID_ROWS - dim.h + 1);
        const valid = canPlaceAt(currentLayout, mod.id, startCol, startRow, mod.size);

        for (let r = startRow; r < startRow + dim.h; r++) {
            for (let c = startCol; c < startCol + dim.w; c++) {
                const cell = document.querySelector(`.dash-grid-cell[data-col="${c}"][data-row="${r}"]`);
                if (cell) {
                    cell.classList.add(valid ? "is-drop-valid" : "is-drop-invalid");
                }
            }
        }
    }

    /* Opens the modal dialog allowing users to add unplaced widgets */
    function openAddModuleModal() {
        const modal = document.getElementById("dash-module-modal");
        const listEl = document.getElementById("dash-modal-list");
        if (!modal || !listEl) return;

        listEl.innerHTML = "";
        const activeIds = new Set(currentLayout.map(function (m) { return m.id; }));
        const available = MODULE_CATALOG.filter(function (m) { return !activeIds.has(m.id); });

        if (available.length === 0) {
            const empty = document.createElement("div");
            empty.className = "dash-modal-empty";
            empty.textContent = "All available telemetry modules are already placed on your dashboard.";
            listEl.appendChild(empty);
        } else {
            available.forEach(function (meta) {
                const row = document.createElement("div");
                row.className = "dash-modal-item";
                row.innerHTML = `
                    <div class="dash-modal-item-info">
                        <span class="dash-modal-item-name">${meta.title} <small class="text-muted">(${meta.defaultSize})</small></span>
                        <span class="dash-modal-item-desc">${meta.desc}</span>
                    </div>
                `;
                const addBtn = document.createElement("button");
                addBtn.type = "button";
                addBtn.className = "dash-bar-btn dash-bar-btn-primary";
                addBtn.innerHTML = '<i class="fa-solid fa-plus"></i><span>Add</span>';
                addBtn.addEventListener("click", function () {
                    handleAddModule(meta.id);
                });
                row.appendChild(addBtn);
                listEl.appendChild(row);
            });
        }

        modal.hidden = false;
    }

    /* Closes the add module modal dialog */
    function closeAddModuleModal() {
        const modal = document.getElementById("dash-module-modal");
        if (modal) modal.hidden = true;
    }

    /* Toggles edit mode, exposing drag handles, size toggles and grid drop targets */
    function setEditMode(enabled) {
        isEditMode = Boolean(enabled);
        const wrapper = document.getElementById("dashboard-wrapper");
        const editBar = document.getElementById("dash-edit-bar");
        if (wrapper) wrapper.classList.toggle("is-editing", isEditMode);
        if (editBar) editBar.hidden = !isEditMode;

        Object.keys(activeInstances).forEach(function (id) {
            const ctrl = registeredControllers[id];
            const inst = activeInstances[id];
            if (ctrl && typeof ctrl.resize === "function" && inst) {
                setTimeout(function () {
                    ctrl.resize(inst.bodyEl);
                }, 50);
            }
        });
    }

    /* Fetches saved dashboard layout configuration from the server */
    async function loadDashboardConfig() {
        try {
            const response = await fetch("/api/dashboard-config", {
                headers: authHeaders()
            });
            if (response.status === 401) {
                window.location.href = "/auth";
                return;
            }
            const data = await response.json();
            if (data.status === "success" && data.config) {
                const configTheme = typeof data.config.theme === "string" ? data.config.theme : "default";
                const configAccent = typeof data.config.accentColor === "string" ? data.config.accentColor : null;
                if (window.TSWTheme && typeof window.TSWTheme.apply === "function") {
                    window.TSWTheme.apply(configTheme, configAccent);
                }

                if (Array.isArray(data.config.modules) && data.config.modules.length > 0) {
                    const fitsInGrid = data.config.modules.every(function (m) {
                        const dim = parseSize(m.size);
                        return VALID_SIZES.includes(m.size) &&
                            m.col >= 1 && m.row >= 1 &&
                            (m.col + dim.w - 1) <= GRID_COLS &&
                            (m.row + dim.h - 1) <= GRID_ROWS;
                    });
                    if (fitsInGrid) {
                        currentLayout = cloneLayout(data.config.modules);
                        savedLayoutSnapshot = cloneLayout(currentLayout);
                        return;
                    }
                }
            }
        } catch (err) {
        }

        currentLayout = cloneLayout(DEFAULT_MODULES);
        savedLayoutSnapshot = cloneLayout(currentLayout);
        await saveDashboardConfig(currentLayout);
    }

    /* Persists custom dashboard layouts and themes to the server */
    async function saveDashboardConfig(modulesList) {
        try {
            const currentTheme = window.TSWTheme && typeof window.TSWTheme.getCurrent === "function"
                ? window.TSWTheme.getCurrent()
                : (localStorage.getItem("tsw6ti_theme") || "default");
            const payload = {
                theme: currentTheme,
                modules: modulesList
            };
            const savedAccent = localStorage.getItem("tsw6ti_accent_color");
            if (savedAccent) {
                payload.accentColor = savedAccent;
            }
            const response = await fetch("/api/dashboard-config", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify(payload)
            });
            if (response.ok) {
                savedLayoutSnapshot = cloneLayout(modulesList);
                return true;
            }
        } catch (err) {
        }
        return false;
    }

    /* Loads route station coordinate database from the API */
    async function loadRoutesDatabase() {
        try {
            const response = await fetch("/api/routes");
            if (!response.ok) return;
            const data = await response.json();
            if (data.status === "success" && Array.isArray(data.routes)) {
                routesCatalog = data.routes;
            }
        } catch (err) {
        }
    }

    /* Calculates great-circle distance in statute miles between two coordinate points */
    function distanceMiles(lat1, lon1, lat2, lon2) {
        const R = 3958.8;
        const toRad = function (d) { return (d * Math.PI) / 180; };
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
        return R * c;
    }

    /* Analyzes train GPS coordinates against route networks to determine route, direction and next station */
    function updateRouteTelemetry(coords) {
        if (!coords || typeof coords.latitude !== "number" || typeof coords.longitude !== "number") {
            return;
        }
        if (!routesCatalog || routesCatalog.length === 0) {
            return;
        }

        const lat = coords.latitude;
        const lon = coords.longitude;

        let activeRoute = null;
        let globalMinDist = Infinity;

        for (let r = 0; r < routesCatalog.length; r++) {
            const route = routesCatalog[r];
            const stations = route.stations || [];
            for (let s = 0; s < stations.length; s++) {
                const d = distanceMiles(lat, lon, stations[s].lat, stations[s].lon);
                if (d < globalMinDist) {
                    globalMinDist = d;
                    activeRoute = route;
                }
            }
        }

        if (!activeRoute || !activeRoute.stations || activeRoute.stations.length < 2) {
            return;
        }

        const line = activeRoute.stations;

        let nearestIdx = 0;
        let nearestDist = Infinity;
        for (let i = 0; i < line.length; i++) {
            const d = distanceMiles(lat, lon, line[i].lat, line[i].lon);
            if (d < nearestDist) {
                nearestDist = d;
                nearestIdx = i;
            }
        }

        let bestSegment = 0;
        let bestScore = Infinity;
        for (let i = 0; i < line.length - 1; i++) {
            const start = line[i];
            const end = line[i + 1];
            const d1 = distanceMiles(lat, lon, start.lat, start.lon);
            const d2 = distanceMiles(lat, lon, end.lat, end.lon);
            const segLen = distanceMiles(start.lat, start.lon, end.lat, end.lon);
            const score = (d1 + d2) - segLen;
            if (score < bestScore) {
                bestScore = score;
                bestSegment = i;
            }
        }

        const stationA = line[bestSegment];
        const stationB = line[bestSegment + 1];
        const distA = distanceMiles(lat, lon, stationA.lat, stationA.lon);
        const distB = distanceMiles(lat, lon, stationB.lat, stationB.lon);

        const atStartEnd = nearestIdx === 0 && distA <= 0.2;
        const atFarEnd = nearestIdx === line.length - 1 && distB <= 0.2;

        if (routeTracker.routeID !== activeRoute.routeID) {
            routeTracker.routeID = activeRoute.routeID;
            routeTracker.segmentIdx = bestSegment;
            routeTracker.anchorLat = lat;
            routeTracker.anchorLon = lon;
            routeTracker.anchorDistA = distA;
            routeTracker.anchorDistB = distB;
            if (atFarEnd) {
                routeTracker.direction = "backward";
            } else if (atStartEnd) {
                routeTracker.direction = "forward";
            } else {
                routeTracker.direction = routeTracker.direction || "forward";
            }
        } else if (routeTracker.segmentIdx !== bestSegment) {
            const prevSeg = routeTracker.segmentIdx;
            if (typeof prevSeg === "number") {
                if (bestSegment > prevSeg) {
                    routeTracker.direction = "forward";
                } else if (bestSegment < prevSeg) {
                    routeTracker.direction = "backward";
                }
            }
            routeTracker.segmentIdx = bestSegment;
            routeTracker.anchorLat = lat;
            routeTracker.anchorLon = lon;
            routeTracker.anchorDistA = distA;
            routeTracker.anchorDistB = distB;
        } else {
            const movedMiles = distanceMiles(routeTracker.anchorLat, routeTracker.anchorLon, lat, lon);
            if (movedMiles >= 0.0005) {
                const closerToA = routeTracker.anchorDistA - distA;
                const closerToB = routeTracker.anchorDistB - distB;

                if (closerToB > closerToA) {
                    routeTracker.direction = "forward";
                } else if (closerToA > closerToB) {
                    routeTracker.direction = "backward";
                }

                routeTracker.anchorLat = lat;
                routeTracker.anchorLon = lon;
                routeTracker.anchorDistA = distA;
                routeTracker.anchorDistB = distB;
            } else if (telemetryState.speedMph < 1.0) {
                if (atFarEnd) {
                    routeTracker.direction = "backward";
                } else if (atStartEnd) {
                    routeTracker.direction = "forward";
                }
            }
        }

        const direction = routeTracker.direction || "forward";
        let departedStation = direction === "forward" ? stationA : stationB;
        let targetStation = direction === "forward" ? stationB : stationA;

        if (direction === "forward" && distB <= 0.03 && bestSegment + 2 < line.length) {
            departedStation = stationB;
            targetStation = line[bestSegment + 2];
        } else if (direction === "backward" && distA <= 0.03 && bestSegment - 1 >= 0) {
            departedStation = stationA;
            targetStation = line[bestSegment - 1];
        }

        const terminusStation = direction === "forward" ? line[line.length - 1] : line[0];

        const targetStopCoord = direction === "forward"
            ? (targetStation.forEnd || targetStation.forStart || targetStation)
            : (targetStation.backEnd || targetStation.backStart || targetStation);

        const departedCoord = direction === "forward"
            ? (departedStation.forEnd || departedStation.forStart || departedStation)
            : (departedStation.backEnd || departedStation.backStart || departedStation);

        const distanceToNextMiles = distanceMiles(lat, lon, targetStopCoord.lat, targetStopCoord.lon);
        const distanceFromPrevMiles = distanceMiles(lat, lon, departedCoord.lat, departedCoord.lon);

        const isAtDepartureStation = distanceFromPrevMiles <= 0.06 && distanceFromPrevMiles < distanceToNextMiles && telemetryState.speedMph < 12;

        telemetryState.route = {
            routeID: activeRoute.routeID,
            routeName: activeRoute.routeName,
            direction: direction,
            previous: departedStation.name,
            next: targetStation.name,
            terminus: terminusStation.name,
            distanceToNextMiles: distanceToNextMiles,
            distanceFromPrevMiles: distanceFromPrevMiles,
            isAtDepartureStation: isAtDepartureStation
        };
    }

    /* Calculates distance in metres between two coordinate pairs using the Haversine formula */
    function haversineMeters(a, b) {
        const R = 6371000;
        const toRad = function (d) { return (d * Math.PI) / 180; };
        const dLat = toRad(b.latitude - a.latitude);
        const dLon = toRad(b.longitude - a.longitude);
        const lat1 = toRad(a.latitude);
        const lat2 = toRad(b.latitude);
        const sinLat = Math.sin(dLat / 2);
        const sinLon = Math.sin(dLon / 2);
        const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    /* Periodically polls all telemetry endpoints from TSW6 and distributes values to active modules */
    async function pollTelemetry() {
        if (!window.TSW6) return;

        syncUnitMultipliers();

        const [
            speedStr,
            limitStr,
            trainName,
            coords,
            throttle,
            brake,
            weather,
            dateTime
        ] = await Promise.all([
            window.TSW6.getCurrentSpeed(),
            window.TSW6.getCurrentSpeedLimit(),
            window.TSW6.getTrainName(),
            window.TSW6.getCurrentTrainCoordinates(),
            window.TSW6.getThrottleLevel(),
            window.TSW6.getBrakeLevel(),
            window.TSW6.getWeather(),
            window.TSW6.getCurrentDateTime()
        ]);

        const accelStr = window.TSW6.getCurrentAcceleration();

        const rawSpeedMph = speedStr !== null ? parseFloat(speedStr) || 0 : 0;
        const rawLimitMph = limitStr && limitStr !== "N/A" && limitStr !== "None" ? parseFloat(limitStr) || 0 : 0;
        const rawAccel = accelStr && accelStr !== "N/A" ? parseFloat(accelStr) || 0 : 0;

        telemetryState.speedMph = rawSpeedMph;
        telemetryState.limitMph = rawLimitMph;
        telemetryState.speed = convertMph(rawSpeedMph);
        telemetryState.speedLimit = rawLimitMph > 0 ? convertMph(rawLimitMph) : 0;
        telemetryState.acceleration = rawAccel;
        telemetryState.trainName = trainName || "Unknown";
        telemetryState.dateTime = dateTime || "";
        telemetryState.throttle = throttle;
        telemetryState.brake = brake;
        telemetryState.weather = weather;

        if (coords && typeof coords.latitude === "number" && typeof coords.longitude === "number") {
            if (telemetryState.lastCoordinates) {
                const stepMeters = haversineMeters(telemetryState.lastCoordinates, coords);
                if (stepMeters > 0.2 && stepMeters < 500) {
                    telemetryState.distanceMeters += stepMeters;
                }
            }
            telemetryState.lastCoordinates = coords;
            telemetryState.coordinates = coords;
            updateRouteTelemetry(coords);
        }

        const isOverspeed = telemetryState.speedLimit > 0 && telemetryState.speed > telemetryState.speedLimit;
        if (isOverspeed && !telemetryState.wasOverspeed) {
            telemetryState.overspeedCount += 1;
        }
        telemetryState.wasOverspeed = isOverspeed;

        if (telemetryState.speed > telemetryState.topSpeed) {
            telemetryState.topSpeed = telemetryState.speed;
        }
        if (rawAccel > telemetryState.peakAccel) {
            telemetryState.peakAccel = rawAccel;
        }
        if (rawAccel < -telemetryState.peakBrake) {
            telemetryState.peakBrake = Math.abs(rawAccel);
        }

        const timeLabel = new Date().toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });

        telemetryState.speedHistory.push(telemetryState.speed);
        telemetryState.limitHistory.push(telemetryState.speedLimit);
        telemetryState.accelHistory.push(rawAccel);
        telemetryState.timeLabels.push(timeLabel);

        if (telemetryState.speedHistory.length > MAX_HISTORY) {
            telemetryState.speedHistory.shift();
            telemetryState.limitHistory.shift();
            telemetryState.accelHistory.shift();
            telemetryState.timeLabels.shift();
        }

        const moving = telemetryState.speedHistory.filter(function (v) { return v > 0.1; });
        telemetryState.avgSpeed = moving.length
            ? moving.reduce(function (a, b) { return a + b; }, 0) / moving.length
            : 0;

        persistSessionTelemetry();

        if (window.TSWRecorder && typeof window.TSWRecorder.isRecording === "function" && window.TSWRecorder.isRecording()) {
            window.TSWRecorder.recordSample({
                t: Date.now(),
                simTime: telemetryState.dateTime || "",
                speedMph: rawSpeedMph,
                limitMph: rawLimitMph,
                accel: rawAccel,
                throttle: typeof throttle === "number" ? throttle : null,
                brake: typeof brake === "number" ? brake : null,
                lat: coords && typeof coords.latitude === "number" ? coords.latitude : null,
                lon: coords && typeof coords.longitude === "number" ? coords.longitude : null,
                trainName: telemetryState.trainName,
                routeID: telemetryState.route ? telemetryState.route.routeID : null,
                direction: telemetryState.route ? telemetryState.route.direction : null,
                weather: weather || null
            });
        }

        currentLayout.forEach(function (mod) {
            const inst = activeInstances[mod.id];
            const ctrl = registeredControllers[mod.id];
            if (inst && ctrl && typeof ctrl.update === "function") {
                ctrl.update(inst.bodyEl, telemetryState, mod.size);
            }
        });
    }

    let dashboardMountPromise = null;

    /* Binds click and drag listeners for toolbar actions (add, reset, cancel, save) */
    function bindToolbarEvents() {
        const addBtn = document.getElementById("dash-add-module-btn");
        const resetBtn = document.getElementById("dash-reset-btn");
        const cancelBtn = document.getElementById("dash-cancel-btn");
        const saveBtn = document.getElementById("dash-save-btn");
        const modalCloseBtn = document.getElementById("dash-modal-close");
        const modalBackdrop = document.getElementById("dash-module-modal");

        if (addBtn && !addBtn.dataset.bound) {
            addBtn.dataset.bound = "1";
            addBtn.addEventListener("click", openAddModuleModal);
        }
        if (modalCloseBtn && !modalCloseBtn.dataset.bound) {
            modalCloseBtn.dataset.bound = "1";
            modalCloseBtn.addEventListener("click", closeAddModuleModal);
        }
        if (modalBackdrop && !modalBackdrop.dataset.bound) {
            modalBackdrop.dataset.bound = "1";
            modalBackdrop.addEventListener("click", function (e) {
                if (e.target === modalBackdrop) closeAddModuleModal();
            });
        }

        if (resetBtn && !resetBtn.dataset.bound) {
            resetBtn.dataset.bound = "1";
            resetBtn.addEventListener("click", async function () {
                currentLayout = cloneLayout(DEFAULT_MODULES);
                await renderFullGrid();
                setEditHint("Reset to default 5×3 layout. Click Save Layout to persist.", false);
            });
        }

        if (cancelBtn && !cancelBtn.dataset.bound) {
            cancelBtn.dataset.bound = "1";
            cancelBtn.addEventListener("click", async function () {
                currentLayout = cloneLayout(savedLayoutSnapshot);
                await renderFullGrid();
                setEditMode(false);
                window.history.replaceState({}, "", "/dashboard");
            });
        }

        if (saveBtn && !saveBtn.dataset.bound) {
            saveBtn.dataset.bound = "1";
            saveBtn.addEventListener("click", async function () {
                saveBtn.disabled = true;
                await saveDashboardConfig(currentLayout);
                saveBtn.disabled = false;
                setEditMode(false);
                window.history.replaceState({}, "", "/dashboard");
            });
        }
    }

    /* Ensures the dashboard grid and required data stores are fully mounted */
    async function ensureDashboardMounted() {
        if (dashboardMountPromise) return dashboardMountPromise;

        dashboardMountPromise = (async function () {
            let wrapper = document.getElementById("dashboard-wrapper");
            if (!wrapper) {
                const workspace = document.getElementById("telem-workspace") || document.querySelector(".telem-workspace");
                if (workspace) {
                    try {
                        const response = await fetch("/dashboard");
                        if (response.ok) {
                            const html = await response.text();
                            const doc = new DOMParser().parseFromString(html, "text/html");
                            const fetchedDash = doc.getElementById("dashboard-wrapper");
                            if (fetchedDash) {
                                fetchedDash.hidden = true;
                                workspace.appendChild(fetchedDash);
                                wrapper = fetchedDash;
                            }
                        }
                    } catch (err) {
                    }
                }
            }

            buildBackgroundDropCells();
            bindToolbarEvents();

            await Promise.all([
                loadRoutesDatabase(),
                loadDashboardConfig()
            ]);
            await renderFullGrid();
        })();

        return dashboardMountPromise;
    }

    /* Triggers resize and update passes across all currently mounted module controllers */
    function refreshVisibleModules() {
        requestAnimationFrame(function () {
            currentLayout.forEach(function (mod) {
                const inst = activeInstances[mod.id];
                const ctrl = registeredControllers[mod.id];
                if (!inst || !ctrl) return;
                if (typeof ctrl.onResize === "function") {
                    ctrl.onResize(inst.bodyEl, mod.size);
                } else if (typeof ctrl.resize === "function") {
                    ctrl.resize(inst.bodyEl);
                }
                if (typeof ctrl.update === "function") {
                    ctrl.update(inst.bodyEl, telemetryState, mod.size);
                }
            });
        });
    }

    /* Creates an isolated dashboard playback session for telemetry recording replaying */
    async function createReplaySession(gridContainerEl, initialState) {
        if (!gridContainerEl) return null;
        await ensureDashboardMounted();

        const replayLayout = cloneLayout(currentLayout.length ? currentLayout : DEFAULT_MODULES);
        const replayInstances = {};
        gridContainerEl.innerHTML = "";

        for (let i = 0; i < replayLayout.length; i++) {
            const mod = replayLayout[i];
            const slot = document.createElement("section");
            slot.className = "module-slot";
            slot.setAttribute("data-module", mod.id);
            applySlotGridPosition(slot, mod);

            const body = document.createElement("div");
            body.className = "module-body";
            slot.appendChild(body);
            gridContainerEl.appendChild(slot);

            replayInstances[mod.id] = { slotEl: slot, bodyEl: body, size: mod.size };
            await hydrateModuleBody(mod, body, initialState || telemetryState);
        }

        return {
            updateFrame: function (frameState) {
                Object.keys(replayInstances).forEach(function (id) {
                    const inst = replayInstances[id];
                    const ctrl = registeredControllers[id];
                    if (inst && ctrl && typeof ctrl.update === "function") {
                        ctrl.update(inst.bodyEl, frameState, inst.size);
                    }
                });
            },
            resize: function () {
                Object.keys(replayInstances).forEach(function (id) {
                    const inst = replayInstances[id];
                    const ctrl = registeredControllers[id];
                    if (inst && ctrl) {
                        if (typeof ctrl.onResize === "function") {
                            ctrl.onResize(inst.bodyEl, inst.size);
                        } else if (typeof ctrl.resize === "function") {
                            ctrl.resize(inst.bodyEl);
                        }
                    }
                });
            },
            destroy: function () {
                Object.keys(replayInstances).forEach(function (id) {
                    const inst = replayInstances[id];
                    const ctrl = registeredControllers[id];
                    if (inst && ctrl && typeof ctrl.destroy === "function") {
                        ctrl.destroy(inst.bodyEl);
                    }
                });
                gridContainerEl.innerHTML = "";
            }
        };
    }

    /* Exposes the dashboard controller API globally */
    window.TSWDashboard = {
        registerModule: function (moduleId, controller) {
            registeredControllers[moduleId] = controller;
        },
        getState: function () {
            return telemetryState;
        },
        getUnitMeta: function () {
            syncUnitMultipliers();
            return {
                speedUnit: telemetryState.speedUnit,
                unitLabel: telemetryState.unitLabel,
                maxGaugeSpeed: telemetryState.maxGaugeSpeed
            };
        },
        convertMph: function (mph) {
            syncUnitMultipliers();
            return convertMph(mph);
        },
        createReplaySession: createReplaySession,
        ensureMounted: ensureDashboardMounted,
        onShow: function (editRequested) {
            setEditMode(Boolean(editRequested));
            refreshVisibleModules();
        }
    };

    /* Bootstraps the telemetry dashboard and polling interval on DOM ready */
    document.addEventListener("DOMContentLoaded", async function () {
        syncUnitMultipliers();
        restoreSessionTelemetry();

        window.addEventListener("tsw6:speedunit", function () {
            syncUnitMultipliers();
            telemetryState.speedHistory.fill(0);
            telemetryState.limitHistory.fill(0);
            telemetryState.topSpeed = 0;
            persistSessionTelemetry();
            refreshVisibleModules();
        });

        window.addEventListener("tsw6:theme", function () {
            refreshVisibleModules();
        });

        await ensureDashboardMounted();

        const params = new URLSearchParams(window.location.search);
        if (params.get("edit") === "1") {
            setEditMode(true);
        }

        await pollTelemetry();
        setInterval(pollTelemetry, TELEMETRY_POLL_MS);
    });
})();
