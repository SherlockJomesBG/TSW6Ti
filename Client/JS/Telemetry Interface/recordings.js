/* Here lies the JavaScript concerned with telemetry recordings and trip logs */
/* This handles recording catalogues, session playback with timeline scrubbing, analytical charts and PDF export */
/* Remember consistency is key */

(function () {
    /* Session token storage key and maximum sample window count */
    const TOKEN_KEY = "tsw6ti_session_token";
    const MAX_HISTORY = 60;

    /* Local state variables for recording archives, replay timelines and chart instances */
    let recordingsList = [];
    let activeArchive = null;
    let replaySession = null;
    let replayTimer = null;
    let replayIndex = 0;
    let isPlaying = false;
    let playbackSpeed = 1;
    let overviewSpeedChart = null;
    let overviewDynChart = null;
    let currentSubView = "library";

    /* Generates authorization headers with bearer token */
    function authHeaders(extra) {
        return Object.assign(
            { Authorization: "Bearer " + localStorage.getItem(TOKEN_KEY) },
            extra
        );
    }

    /* Formats numeric seconds into clean HH:MM:SS or MM:SS durations */
    function fmtDuration(sec) {
        const s = Math.max(0, Math.round(Number(sec) || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const rem = s % 60;
        const mm = String(m).padStart(2, "0");
        const ss = String(rem).padStart(2, "0");
        return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }

    /* Formats byte counts into human-readable B, KB or MB strings */
    function fmtBytes(bytes) {
        const b = Number(bytes) || 0;
        if (b < 1024) return b + " B";
        if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
        return (b / (1024 * 1024)).toFixed(2) + " MB";
    }

    /* Formats ISO timestamp dates into British English strings */
    function fmtDate(isoStr) {
        if (!isoStr) return "—";
        const d = new Date(isoStr);
        if (Number.isNaN(d.getTime())) return String(isoStr);
        return d.toLocaleString("en-GB", {
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit"
        });
    }

    /* HTML escaping helper to prevent script injection */
    function escapeHtml(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    /* Reads active speed unit preferences from the dashboard configuration */
    function getUnitConfig() {
        if (window.TSWDashboard && typeof window.TSWDashboard.getUnitMeta === "function") {
            return window.TSWDashboard.getUnitMeta();
        }
        return { speedUnit: "MPH", unitLabel: "mph", maxGaugeSpeed: 140 };
    }

    /* Converts speeds from mph to the user's preferred measurement unit */
    function convertMph(mph) {
        if (window.TSWDashboard && typeof window.TSWDashboard.convertMph === "function") {
            return window.TSWDashboard.convertMph(mph);
        }
        return mph;
    }

    /* Halts the active playback loop and resets the play/pause button icon */
    function stopReplayLoop() {
        isPlaying = false;
        if (replayTimer) {
            clearInterval(replayTimer);
            replayTimer = null;
        }
        const toggleBtn = document.getElementById("rec-play-toggle");
        if (toggleBtn) {
            toggleBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        }
    }

    /* Switches between library, replay and overview sub-views */
    function setSubView(viewName) {
        currentSubView = viewName;
        const libEl = document.getElementById("rec-library-view");
        const repEl = document.getElementById("rec-replay-view");
        const ovEl = document.getElementById("rec-overview-view");

        if (libEl) libEl.hidden = viewName !== "library";
        if (repEl) repEl.hidden = viewName !== "replay";
        if (ovEl) ovEl.hidden = viewName !== "overview";

        if (viewName !== "replay") {
            stopReplayLoop();
        }
    }

    /* Fetches saved telemetry recordings from the backend */
    async function fetchRecordingsList() {
        const statusEl = document.getElementById("rec-list-status");
        const gridEl = document.getElementById("rec-cards-grid");
        if (statusEl) {
            statusEl.textContent = "Loading recordings...";
            statusEl.hidden = false;
        }
        if (gridEl) gridEl.innerHTML = "";

        try {
            const response = await fetch("/api/recordings", { headers: authHeaders() });
            if (response.status === 401) {
                window.location.href = "/auth";
                return;
            }
            const data = await response.json();
            if (data.status === "success" && Array.isArray(data.recordings)) {
                recordingsList = data.recordings;
                renderRecordingsCards();
            } else if (statusEl) {
                statusEl.textContent = data.message || "Could not load recordings.";
                statusEl.hidden = false;
            }
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = "Failed to load recordings from server.";
                statusEl.hidden = false;
            }
        }
    }

    /* Populates recording cards into the library grid */
    function renderRecordingsCards() {
        const statusEl = document.getElementById("rec-list-status");
        const gridEl = document.getElementById("rec-cards-grid");
        const searchEl = document.getElementById("rec-search-input");
        if (!gridEl || !statusEl) return;

        const query = searchEl ? searchEl.value.trim().toLowerCase() : "";
        const filtered = recordingsList.filter(function (r) {
            if (!query) return true;
            const hay = `${r.routeName} ${r.originStation} ${r.destinationStation} ${r.trainName} ${r.title}`.toLowerCase();
            return hay.includes(query);
        });

        gridEl.innerHTML = "";
        if (filtered.length === 0) {
            statusEl.textContent = recordingsList.length === 0
                ? "No telemetry recordings saved yet. Press Record in the top bar while driving to capture your first run."
                : "No recordings match your search filter.";
            statusEl.hidden = false;
            return;
        }
        statusEl.hidden = true;

        const unitMeta = getUnitConfig();
        filtered.forEach(function (rec) {
            const card = document.createElement("article");
            card.className = "rec-card";
            const topSpd = Math.round(convertMph(rec.topSpeedMph || 0));
            const isMetric = unitMeta.speedUnit === "KMH" || unitMeta.speedUnit === "MS";
            const distVal = ((rec.distanceMiles || 0) * (isMetric ? 1.609344 : 1)).toFixed(2);
            const distUnit = isMetric ? "km" : "mi";

            card.innerHTML = `
                <div class="rec-card-top">
                    <div>
                        <div class="rec-card-route">${escapeHtml(rec.routeName || "Unknown Route")}</div>
                        <h2 class="rec-card-trip">${escapeHtml(rec.originStation || "?")} &rarr; ${escapeHtml(rec.destinationStation || "?")}</h2>
                        <div class="rec-card-train"><i class="fa-solid fa-train-subway"></i> ${escapeHtml(rec.trainName || "Unknown")}</div>
                    </div>
                    <span class="rec-card-size" title="Compressed archive size">${fmtBytes(rec.fileSizeBytes)}</span>
                </div>
                <div class="rec-card-stats">
                    <div class="rec-card-stat">
                        <span class="rec-card-stat-k">Duration</span>
                        <span class="rec-card-stat-v">${fmtDuration(rec.durationSec)}</span>
                    </div>
                    <div class="rec-card-stat">
                        <span class="rec-card-stat-k">Distance</span>
                        <span class="rec-card-stat-v">${distVal} ${distUnit}</span>
                    </div>
                    <div class="rec-card-stat">
                        <span class="rec-card-stat-k">Top Speed</span>
                        <span class="rec-card-stat-v">${topSpd} ${unitMeta.unitLabel}</span>
                    </div>
                    <div class="rec-card-stat">
                        <span class="rec-card-stat-k">Overspeeds</span>
                        <span class="rec-card-stat-v ${rec.overspeedCount > 0 ? "is-warn" : ""}">${rec.overspeedCount || 0}</span>
                    </div>
                </div>
                <div class="rec-card-footer">
                    <span class="rec-card-date">${fmtDate(rec.startedAt)}</span>
                    <div class="rec-card-actions">
                        <button type="button" class="rec-btn rec-btn-primary" data-action="replay" data-id="${escapeHtml(rec.recordingID)}">
                            <i class="fa-solid fa-play"></i><span>Replay</span>
                        </button>
                        <button type="button" class="rec-btn rec-btn-secondary" data-action="overview" data-id="${escapeHtml(rec.recordingID)}">
                            <i class="fa-solid fa-chart-line"></i><span>Overview</span>
                        </button>
                        <button type="button" class="rec-btn rec-btn-ghost" data-action="pdf" data-id="${escapeHtml(rec.recordingID)}" title="Download PDF Report">
                            <i class="fa-solid fa-file-pdf"></i><span>PDF</span>
                        </button>
                        <button type="button" class="rec-btn rec-btn-danger" data-action="delete" data-id="${escapeHtml(rec.recordingID)}" title="Delete Recording">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
            gridEl.appendChild(card);
        });
    }

    /* Retrieves complete recording archive JSON including metadata and telemetry samples */
    async function loadRecordingDetail(recordingID) {
        if (activeArchive && activeArchive.meta && activeArchive.meta.recordingID === recordingID) {
            return activeArchive;
        }
        const response = await fetch(`/api/recordings/${encodeURIComponent(recordingID)}`, {
            headers: authHeaders()
        });
        if (!response.ok) {
            throw new Error("Could not load recording");
        }
        const data = await response.json();
        if (data.status !== "success" || !data.recording) {
            throw new Error(data.message || "Invalid recording response");
        }
        activeArchive = data.recording;
        return activeArchive;
    }

    /* Downloads generated PDF trip reports */
    async function downloadRecordingPdf(recordingID) {
        try {
            const response = await fetch(`/api/recordings/${encodeURIComponent(recordingID)}/pdf`, {
                headers: authHeaders()
            });
            if (!response.ok) {
                let errMsg = "Failed to generate PDF report.";
                try {
                    const errJson = await response.json();
                    if (errJson.message) errMsg = errJson.message;
                } catch (e) { /* ignore */ }
                if (window.TSWToast) window.TSWToast.show(errMsg, null, true);
                return;
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `TSW6_Recording_${recordingID}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            if (window.TSWToast) window.TSWToast.show("Error downloading PDF report.", null, true);
        }
    }

    /* Deletes a saved recording session */
    async function deleteRecordingById(recordingID) {
        if (!window.confirm("Delete this recording permanently?")) return;
        try {
            const response = await fetch(`/api/recordings/${encodeURIComponent(recordingID)}`, {
                method: "DELETE",
                headers: authHeaders()
            });
            if (response.ok) {
                recordingsList = recordingsList.filter(function (r) { return r.recordingID !== recordingID; });
                if (activeArchive && activeArchive.meta && activeArchive.meta.recordingID === recordingID) {
                    activeArchive = null;
                }
                renderRecordingsCards();
            }
        } catch (err) {
        }
    }

    /* Builds the full telemetry dashboard state at a specific sample index */
    function buildReplayStateAtIndex(archive, idx) {
        const meta = archive.meta;
        const samples = archive.samples || [];
        const clampedIdx = Math.max(0, Math.min(samples.length - 1, idx));
        const unitMeta = getUnitConfig();

        const speedHistory = [];
        const limitHistory = [];
        const accelHistory = [];
        const timeLabels = [];

        const startSlice = Math.max(0, clampedIdx - MAX_HISTORY + 1);
        for (let i = startSlice; i <= clampedIdx; i++) {
            const s = samples[i];
            speedHistory.push(convertMph(s.speedMph || 0));
            limitHistory.push(s.limitMph > 0 ? convertMph(s.limitMph) : 0);
            accelHistory.push(s.accel || 0);
            const sim = s.simTime || "";
            const timePart = sim.includes(" ") ? sim.split(" ")[1] : fmtDuration(s.t);
            timeLabels.push(timePart || fmtDuration(s.t));
        }

        while (speedHistory.length < MAX_HISTORY) {
            speedHistory.unshift(0);
            limitHistory.unshift(0);
            accelHistory.unshift(0);
            timeLabels.unshift("");
        }

        let topSpeed = 0;
        let peakAccel = 0;
        let peakBrake = 0;
        let overspeedCount = 0;
        let wasOverspeed = false;
        let speedSum = 0;
        let movingCount = 0;

        for (let i = 0; i <= clampedIdx; i++) {
            const s = samples[i];
            const spd = convertMph(s.speedMph || 0);
            const lim = s.limitMph > 0 ? convertMph(s.limitMph) : 0;
            const acc = s.accel || 0;
            if (spd > topSpeed) topSpeed = spd;
            if (spd > 0.1) {
                speedSum += spd;
                movingCount++;
            }
            if (acc > peakAccel) peakAccel = acc;
            if (acc < -peakBrake) peakBrake = Math.abs(acc);
            const isOver = lim > 0 && spd > lim;
            if (isOver && !wasOverspeed) overspeedCount++;
            wasOverspeed = isOver;
        }

        const cur = samples[clampedIdx] || {};
        const curSpd = convertMph(cur.speedMph || 0);
        const curLim = cur.limitMph > 0 ? convertMph(cur.limitMph) : 0;

        return {
            speedMph: cur.speedMph || 0,
            limitMph: cur.limitMph || 0,
            speed: curSpd,
            speedLimit: curLim,
            speedUnit: unitMeta.speedUnit,
            unitLabel: unitMeta.unitLabel,
            maxGaugeSpeed: unitMeta.maxGaugeSpeed,
            acceleration: cur.accel || 0,
            trainName: meta.trainName || "Unknown",
            dateTime: cur.simTime || "",
            coordinates: typeof cur.lat === "number" ? { latitude: cur.lat, longitude: cur.lon } : null,
            throttle: cur.throttle,
            brake: cur.brake,
            weather: cur.weather || null,
            route: {
                routeID: meta.routeID,
                routeName: cur.routeName || meta.routeName || "Unknown Route",
                direction: meta.direction || "forward",
                previous: cur.prevStation || meta.originStation,
                next: cur.nextStation || meta.destinationStation,
                terminus: meta.terminusStation || meta.destinationStation,
                distanceToNextMiles: cur.distNextMi || 0,
                isAtDepartureStation: (cur.speedMph || 0) < 5 && (cur.distNextMi || 0) > 0.25 && clampedIdx < 15
            },
            speedHistory: speedHistory,
            limitHistory: limitHistory,
            accelHistory: accelHistory,
            timeLabels: timeLabels,
            topSpeed: topSpeed,
            avgSpeed: movingCount ? speedSum / movingCount : 0,
            peakAccel: peakAccel,
            peakBrake: peakBrake,
            overspeedCount: overspeedCount
        };
    }

    /* Renders the current frame during timeline playback or scrubbing */
    function renderCurrentReplayFrame() {
        if (!activeArchive || !replaySession) return;
        const samples = activeArchive.samples || [];
        if (samples.length === 0) return;

        const frame = buildReplayStateAtIndex(activeArchive, replayIndex);
        replaySession.updateFrame(frame);

        const curSample = samples[replayIndex];
        const totalSec = samples[samples.length - 1].t || (samples.length - 1);
        const curEl = document.getElementById("rec-time-current");
        const totEl = document.getElementById("rec-time-total");
        const scrubEl = document.getElementById("rec-scrubber");
        const simBadge = document.getElementById("rec-sim-badge");

        if (curEl) curEl.textContent = fmtDuration(curSample.t);
        if (totEl) totEl.textContent = fmtDuration(totalSec);
        if (scrubEl) scrubEl.value = String(replayIndex);
        if (simBadge) {
            const sim = curSample.simTime || "--:--:--";
            simBadge.textContent = "SIM " + (sim.includes(" ") ? sim.split(" ")[1] : sim);
        }
    }

    /* Starts or resumes continuous timeline playback */
    function startReplayLoop() {
        if (!activeArchive || !activeArchive.samples || activeArchive.samples.length === 0) return;
        stopReplayLoop();
        isPlaying = true;
        const toggleBtn = document.getElementById("rec-play-toggle");
        if (toggleBtn) toggleBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';

        if (replayIndex >= activeArchive.samples.length - 1) {
            replayIndex = 0;
        }

        const tickMs = Math.max(50, Math.round(1000 / playbackSpeed));
        replayTimer = setInterval(function () {
            if (!activeArchive || !activeArchive.samples) return;
            if (replayIndex < activeArchive.samples.length - 1) {
                replayIndex += 1;
                renderCurrentReplayFrame();
            } else {
                stopReplayLoop();
            }
        }, tickMs);
    }

    /* Loads and initialises the live replay dashboard session */
    async function openReplayView(recordingID) {
        const archive = await loadRecordingDetail(recordingID);
        const meta = archive.meta;
        const samples = archive.samples || [];

        setSubView("replay");

        const titleEl = document.getElementById("rec-replay-title");
        const subEl = document.getElementById("rec-replay-subtitle");
        const scrubEl = document.getElementById("rec-scrubber");
        const gridEl = document.getElementById("rec-replay-grid");

        if (titleEl) titleEl.textContent = `${meta.routeName} — ${meta.originStation} → ${meta.destinationStation}`;
        if (subEl) subEl.textContent = `${meta.trainName} • ${fmtDate(meta.startedAt)} • ${samples.length} frames`;
        if (scrubEl) {
            scrubEl.min = "0";
            scrubEl.max = String(Math.max(0, samples.length - 1));
            scrubEl.value = "0";
        }

        replayIndex = 0;
        if (replaySession) {
            replaySession.destroy();
            replaySession = null;
        }

        const initialState = buildReplayStateAtIndex(archive, 0);
        if (window.TSWDashboard && typeof window.TSWDashboard.createReplaySession === "function" && gridEl) {
            replaySession = await window.TSWDashboard.createReplaySession(gridEl, initialState);
            requestAnimationFrame(function () {
                if (replaySession) replaySession.resize();
                renderCurrentReplayFrame();
            });
        }
    }

    /* Cleans up Chart.js instances from the overview view */
    function destroyOverviewCharts() {
        if (overviewSpeedChart) {
            overviewSpeedChart.destroy();
            overviewSpeedChart = null;
        }
        if (overviewDynChart) {
            overviewDynChart.destroy();
            overviewDynChart = null;
        }
    }

    /* Renders the full trip analytical overview with charts, KPIs, station stops and incident tables */
    async function openOverviewView(recordingID) {
        const archive = await loadRecordingDetail(recordingID);
        const meta = archive.meta;
        const samples = archive.samples || [];
        const unitMeta = getUnitConfig();
        const isMetric = unitMeta.speedUnit === "KMH" || unitMeta.speedUnit === "MS";
        const distVal = ((meta.distanceMiles || 0) * (isMetric ? 1.609344 : 1)).toFixed(2);
        const distUnit = isMetric ? "km" : "mi";

        setSubView("overview");
        destroyOverviewCharts();

        const titleEl = document.getElementById("rec-ov-head-title");
        const subEl = document.getElementById("rec-ov-head-sub");
        const contentEl = document.getElementById("rec-overview-content");
        if (titleEl) titleEl.textContent = `${meta.originStation} → ${meta.destinationStation}`;
        if (subEl) subEl.textContent = `${meta.routeName} • ${meta.trainName}`;
        if (!contentEl) return;

        const stationRows = (meta.stationEvents || []).map(function (ev) {
            const cls = ev.status === "Stopped" ? "is-stop" : "is-pass";
            return `
                <tr>
                    <td><strong>${escapeHtml(ev.stationName)}</strong></td>
                    <td>${fmtDuration(ev.arrivedSec)}</td>
                    <td>${fmtDuration(ev.departedSec)}</td>
                    <td>${ev.dwellSec}s</td>
                    <td>${Math.round(convertMph(ev.minSpeedMph))} / ${Math.round(convertMph(ev.maxSpeedMph))} ${unitMeta.unitLabel}</td>
                    <td><span class="rec-status-pill ${cls}">${escapeHtml(ev.status)}</span></td>
                </tr>
            `;
        }).join("") || '<tr><td colspan="6" class="text-muted">No station stops or passes matched within 0.14 mi along this segment.</td></tr>';

        const overRows = (meta.overspeedEvents || []).map(function (ev) {
            const excess = Math.max(0, convertMph((ev.peakSpeedMph || 0) - (ev.limitMph || 0)));
            return `
                <tr>
                    <td>${fmtDuration(ev.startSec)} &ndash; ${fmtDuration(ev.endSec)}</td>
                    <td>${ev.durationSec || 1}s</td>
                    <td><span class="rec-status-pill is-over">${convertMph(ev.peakSpeedMph || 0).toFixed(1)} ${unitMeta.unitLabel}</span></td>
                    <td>${Math.round(convertMph(ev.limitMph || 0))} ${unitMeta.unitLabel}</td>
                    <td>+${excess.toFixed(1)} ${unitMeta.unitLabel}</td>
                    <td>${escapeHtml(ev.nearStation || "—")}</td>
                </tr>
            `;
        }).join("") || '<tr><td colspan="6" style="color: #34d399; font-weight: 600;">Clean drive &mdash; zero overspeed violations recorded.</td></tr>';

        const lastSample = samples[samples.length - 1] || {};
        const firstWeather = (samples[0] && samples[0].weather) || {};
        const endWeather = lastSample.weather || firstWeather;

        contentEl.innerHTML = `
            <div class="rec-ov-hero">
                <div class="rec-ov-route-row">
                    <span class="rec-ov-badge">${escapeHtml(meta.routeName)} &bull; ${escapeHtml(String(meta.direction || "forward").toUpperCase())}</span>
                    <span class="rec-card-size">Terminus: ${escapeHtml(meta.terminusStation || meta.destinationStation)} &bull; ${fmtBytes(meta.fileSizeBytes)}</span>
                </div>
                <h2 class="rec-ov-trip">${escapeHtml(meta.originStation)} &rarr; ${escapeHtml(meta.destinationStation)}</h2>
                <div class="rec-ov-meta-row">
                    <span><strong>Train:</strong> ${escapeHtml(meta.trainName)}</span>
                    <span><strong>Recorded:</strong> ${fmtDate(meta.startedAt)}</span>
                    <span><strong>Sim Span:</strong> ${escapeHtml(meta.simStartTime || "—")} &rarr; ${escapeHtml(meta.simEndTime || "—")}</span>
                </div>
            </div>

            <div class="rec-ov-kpis">
                <div class="rec-ov-kpi"><span class="rec-ov-kpi-label">Duration</span><span class="rec-ov-kpi-val">${fmtDuration(meta.durationSec)}</span></div>
                <div class="rec-ov-kpi"><span class="rec-ov-kpi-label">Distance</span><span class="rec-ov-kpi-val">${distVal} ${distUnit}</span></div>
                <div class="rec-ov-kpi"><span class="rec-ov-kpi-label">Top Speed</span><span class="rec-ov-kpi-val">${convertMph(meta.topSpeedMph || 0).toFixed(1)} ${unitMeta.unitLabel}</span></div>
                <div class="rec-ov-kpi"><span class="rec-ov-kpi-label">Avg Speed</span><span class="rec-ov-kpi-val">${convertMph(meta.avgSpeedMph || 0).toFixed(1)} ${unitMeta.unitLabel}</span></div>
                <div class="rec-ov-kpi"><span class="rec-ov-kpi-label">Peak Accel</span><span class="rec-ov-kpi-val">${Number(meta.peakAccel || 0).toFixed(2)} m/s&sup2;</span></div>
                <div class="rec-ov-kpi"><span class="rec-ov-kpi-label">Peak Brake</span><span class="rec-ov-kpi-val">${Number(meta.peakBrake || 0).toFixed(2)} m/s&sup2;</span></div>
                <div class="rec-ov-kpi"><span class="rec-ov-kpi-label">Overspeeds</span><span class="rec-ov-kpi-val ${meta.overspeedCount > 0 ? "is-warn" : ""}">${meta.overspeedCount || 0}</span></div>
                <div class="rec-ov-kpi"><span class="rec-ov-kpi-label">Samples</span><span class="rec-ov-kpi-val">${meta.sampleCount || samples.length}</span></div>
            </div>

            <div class="rec-ov-panel">
                <h3 class="rec-ov-panel-title">Full-Run Speed vs Track Limit (${unitMeta.unitLabel.toUpperCase()})</h3>
                <div class="rec-ov-chart-wrap"><canvas id="rec-ov-speed-canvas"></canvas></div>
            </div>

            <div class="rec-ov-panel">
                <h3 class="rec-ov-panel-title">Acceleration, Throttle &amp; Brake Telemetry</h3>
                <div class="rec-ov-chart-wrap"><canvas id="rec-ov-dyn-canvas"></canvas></div>
            </div>

            <div class="rec-ov-panel">
                <h3 class="rec-ov-panel-title">Reconciled Station Calls &amp; Passes</h3>
                <div class="rec-ov-table-wrap">
                    <table class="rec-ov-table">
                        <thead><tr><th>Station</th><th>Arrived / Reached</th><th>Departed</th><th>Dwell</th><th>Min / Max Speed</th><th>Status</th></tr></thead>
                        <tbody>${stationRows}</tbody>
                    </table>
                </div>
            </div>

            <div class="rec-ov-panel">
                <h3 class="rec-ov-panel-title">Environment Conditions (Start &rarr; End)</h3>
                <div class="rec-ov-meta-row">
                    <span><strong>Temperature:</strong> ${Math.round(firstWeather.temperature || 0)}&deg;C &rarr; ${Math.round(endWeather.temperature || 0)}&deg;C</span>
                    <span><strong>Cloudiness:</strong> ${Math.round((firstWeather.cloudiness || 0) * 100)}% &rarr; ${Math.round((endWeather.cloudiness || 0) * 100)}%</span>
                    <span><strong>Precipitation:</strong> ${Math.round((firstWeather.precipitation || 0) * 100)}% &rarr; ${Math.round((endWeather.precipitation || 0) * 100)}%</span>
                    <span><strong>Wetness:</strong> ${Math.round((firstWeather.wetness || 0) * 100)}% &rarr; ${Math.round((endWeather.wetness || 0) * 100)}%</span>
                    <span><strong>Fog Density:</strong> ${(firstWeather.fogDensity || 0).toFixed(3)} &rarr; ${(endWeather.fogDensity || 0).toFixed(3)}</span>
                </div>
            </div>

            <div class="rec-ov-panel">
                <h3 class="rec-ov-panel-title">Overspeed Incidents</h3>
                <div class="rec-ov-table-wrap">
                    <table class="rec-ov-table">
                        <thead><tr><th>Time Window</th><th>Duration</th><th>Peak Speed</th><th>Limit</th><th>Max Excess</th><th>Location</th></tr></thead>
                        <tbody>${overRows}</tbody>
                    </table>
                </div>
            </div>
        `;

        if (typeof Chart !== "undefined" && samples.length > 0) {
            const layoutEl = document.querySelector(".telem-layout") || document.documentElement;
            const cs = getComputedStyle(layoutEl);
            const accentBright = cs.getPropertyValue("--accent-bright").trim() || "#8b3dff";
            const accentSubtle = cs.getPropertyValue("--accent-subtle").trim() || "rgba(139, 61, 255, 0.14)";
            const textMuted = cs.getPropertyValue("--text-muted").trim() || "rgba(255,255,255,0.55)";
            const divider = cs.getPropertyValue("--telem-divider").trim() || "rgba(255,255,255,0.12)";

            const step = Math.max(1, Math.floor(samples.length / 450));
            const sliced = samples.filter(function (_, i) { return i % step === 0 || i === samples.length - 1; });
            const labels = sliced.map(function (s) { return fmtDuration(s.t); });

            const spdCanvas = document.getElementById("rec-ov-speed-canvas");
            if (spdCanvas) {
                overviewSpeedChart = new Chart(spdCanvas.getContext("2d"), {
                    type: "line",
                    data: {
                        labels: labels,
                        datasets: [
                            {
                                label: "Speed (" + unitMeta.unitLabel + ")",
                                data: sliced.map(function (s) { return Number(convertMph(s.speedMph || 0).toFixed(2)); }),
                                borderColor: accentBright,
                                backgroundColor: accentSubtle,
                                borderWidth: 2,
                                pointRadius: 0,
                                fill: true,
                                tension: 0.25
                            },
                            {
                                label: "Limit (" + unitMeta.unitLabel + ")",
                                data: sliced.map(function (s) { return s.limitMph > 0 ? Number(convertMph(s.limitMph).toFixed(2)) : null; }),
                                borderColor: "#fbbf24",
                                borderWidth: 1.5,
                                borderDash: [5, 4],
                                pointRadius: 0,
                                fill: false
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: { mode: "index", intersect: false },
                        plugins: { legend: { labels: { color: textMuted } } },
                        scales: {
                            x: { ticks: { color: textMuted, maxTicksLimit: 10 }, grid: { color: divider } },
                            y: { min: 0, ticks: { color: textMuted }, grid: { color: divider } }
                        }
                    }
                });
            }

            const dynCanvas = document.getElementById("rec-ov-dyn-canvas");
            if (dynCanvas) {
                overviewDynChart = new Chart(dynCanvas.getContext("2d"), {
                    type: "line",
                    data: {
                        labels: labels,
                        datasets: [
                            {
                                label: "Acceleration (m/s²)",
                                data: sliced.map(function (s) { return Number((s.accel || 0).toFixed(3)); }),
                                borderColor: "#38bdf8",
                                borderWidth: 1.8,
                                pointRadius: 0,
                                yAxisID: "y",
                                tension: 0.25
                            },
                            {
                                label: "Throttle (%)",
                                data: sliced.map(function (s) { return typeof s.throttle === "number" ? Math.round(s.throttle * 100) : null; }),
                                borderColor: "#34d399",
                                borderWidth: 1.4,
                                pointRadius: 0,
                                yAxisID: "y1",
                                tension: 0.2
                            },
                            {
                                label: "Brake (%)",
                                data: sliced.map(function (s) { return typeof s.brake === "number" ? Math.round(s.brake * 100) : null; }),
                                borderColor: "#fb7185",
                                borderWidth: 1.4,
                                pointRadius: 0,
                                yAxisID: "y1",
                                tension: 0.2
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: { mode: "index", intersect: false },
                        plugins: { legend: { labels: { color: textMuted } } },
                        scales: {
                            x: { ticks: { color: textMuted, maxTicksLimit: 10 }, grid: { color: divider } },
                            y: { position: "left", ticks: { color: textMuted }, grid: { color: divider } },
                            y1: { position: "right", min: 0, max: 100, ticks: { color: textMuted }, grid: { drawOnChartArea: false } }
                        }
                    }
                });
            }
        }
    }

    /* Initialises recordings library controls, scrubber listeners, speed buttons and custom events */
    function initRecordingsUI() {
        const wrapper = document.getElementById("recordings-wrapper");
        if (!wrapper || wrapper.dataset.bound === "1") return;
        wrapper.dataset.bound = "1";

        const searchInput = document.getElementById("rec-search-input");
        if (searchInput) {
            searchInput.addEventListener("input", renderRecordingsCards);
        }

        const cardsGrid = document.getElementById("rec-cards-grid");
        if (cardsGrid) {
            cardsGrid.addEventListener("click", async function (event) {
                const btn = event.target.closest("button[data-action][data-id]");
                if (!btn) return;
                const action = btn.getAttribute("data-action");
                const recId = btn.getAttribute("data-id");
                if (action === "replay") {
                    await openReplayView(recId);
                } else if (action === "overview") {
                    await openOverviewView(recId);
                } else if (action === "pdf") {
                    await downloadRecordingPdf(recId);
                } else if (action === "delete") {
                    await deleteRecordingById(recId);
                }
            });
        }

        const replayBack = document.getElementById("rec-replay-back");
        const overviewBack = document.getElementById("rec-overview-back");
        const toOverviewBtn = document.getElementById("rec-replay-to-overview");
        const toReplayBtn = document.getElementById("rec-overview-to-replay");
        const replayPdfBtn = document.getElementById("rec-replay-pdf");
        const overviewPdfBtn = document.getElementById("rec-overview-pdf");

        if (replayBack) replayBack.addEventListener("click", function () { setSubView("library"); });
        if (overviewBack) overviewBack.addEventListener("click", function () { setSubView("library"); });
        if (toOverviewBtn) {
            toOverviewBtn.addEventListener("click", function () {
                if (activeArchive && activeArchive.meta) openOverviewView(activeArchive.meta.recordingID);
            });
        }
        if (toReplayBtn) {
            toReplayBtn.addEventListener("click", function () {
                if (activeArchive && activeArchive.meta) openReplayView(activeArchive.meta.recordingID);
            });
        }
        if (replayPdfBtn) {
            replayPdfBtn.addEventListener("click", function () {
                if (activeArchive && activeArchive.meta) downloadRecordingPdf(activeArchive.meta.recordingID);
            });
        }
        if (overviewPdfBtn) {
            overviewPdfBtn.addEventListener("click", function () {
                if (activeArchive && activeArchive.meta) downloadRecordingPdf(activeArchive.meta.recordingID);
            });
        }

        const playBtn = document.getElementById("rec-play-toggle");
        const scrubber = document.getElementById("rec-scrubber");
        if (playBtn) {
            playBtn.addEventListener("click", function () {
                if (isPlaying) {
                    stopReplayLoop();
                } else {
                    startReplayLoop();
                }
            });
        }

        if (scrubber) {
            scrubber.addEventListener("input", function () {
                replayIndex = parseInt(scrubber.value, 10) || 0;
                renderCurrentReplayFrame();
            });
        }

        wrapper.querySelectorAll(".rec-ctrl-btn[data-skip]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                if (!activeArchive || !activeArchive.samples) return;
                const delta = parseInt(btn.getAttribute("data-skip"), 10) || 0;
                replayIndex = Math.max(0, Math.min(activeArchive.samples.length - 1, replayIndex + delta));
                renderCurrentReplayFrame();
            });
        });

        wrapper.querySelectorAll(".rec-speed-btn[data-speed]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                playbackSpeed = parseFloat(btn.getAttribute("data-speed")) || 1;
                wrapper.querySelectorAll(".rec-speed-btn").forEach(function (b) {
                    b.classList.toggle("is-active", b === btn);
                });
                if (isPlaying) {
                    startReplayLoop();
                }
            });
        });

        window.addEventListener("tsw6:recording-saved", function () {
            if (!wrapper.hidden) {
                fetchRecordingsList();
            }
        });

        window.addEventListener("tsw6:speedunit", function () {
            if (currentSubView === "replay") renderCurrentReplayFrame();
            else if (currentSubView === "overview" && activeArchive) openOverviewView(activeArchive.meta.recordingID);
            else renderRecordingsCards();
        });

        window.addEventListener("tsw6:theme", function () {
            if (currentSubView === "replay") renderCurrentReplayFrame();
            else if (currentSubView === "overview" && activeArchive) openOverviewView(activeArchive.meta.recordingID);
        });
    }

    /* Handles switching into the recordings tab */
    async function handleShowRecordings(recId) {
        initRecordingsUI();
        await fetchRecordingsList();
        if (recId) {
            try {
                await openOverviewView(recId);
                return;
            } catch (err) { /* fallback to library */ }
        }
        setSubView("library");
    }

    /* Exposes the recordings module globally */
    window.TSWRecordings = {
        init: initRecordingsUI,
        onShow: handleShowRecordings
    };

    /* Initialises the recordings UI on DOM ready */
    document.addEventListener("DOMContentLoaded", function () {
        const wrapper = document.getElementById("recordings-wrapper");
        if (wrapper && !wrapper.hidden) {
            const params = new URLSearchParams(window.location.search);
            handleShowRecordings(params.get("id"));
        }
    });
})();
