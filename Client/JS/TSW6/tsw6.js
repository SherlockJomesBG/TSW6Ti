/* Here lies the JavaScript concerned with Train Sim World 6 HTTP API communication */
/* This handles base URLs, DTGCommKey authentication, extension bridge messaging, telemetry polling and driving controls */
/* Remember consistency is key */

(function () {
    /* Storage key for the active game connection profile and standard TSW6 HTTP API port */
    const STORAGE_KEY = "tsw6ti_active_connection";
    const DEFAULT_PORT = 31270;

    /* Current endpoint base URL and authorization headers */
    let baseUrl = "";
    let headers = {};

    /* Tracking speeds and timestamps for acceleration calculations */
    let oldSpeed = null;
    let newSpeed = null;
    let lastSpeedUpdateTime = null;

    /* Caches the most recent responses by endpoint path to survive intermittent packet drops */
    const _last_known = {};

    /* Smoothed acceleration state and exponential moving average factor */
    let _smoothedAcceleration = 0.0;
    const _accelAlpha = 0.15;

    /* Normalises user-provided IP addresses or hostnames into a valid HTTP origin targeting port 31270 */
    function normalizeBaseUrl(input) {
        if (!input) return "";
        let cleaned = String(input).trim().replace(/\/+$/, "");
        /* TSW6 only supports unencrypted HTTP on port 31270 */
        cleaned = cleaned.replace(/^https?:\/\//i, "");
        cleaned = "http://" + cleaned;
        try {
            const url = new URL(cleaned);
            if (!url.port && url.protocol === "http:") {
                url.port = String(DEFAULT_PORT);
            }
            return url.origin;
        } catch (err) {
            const host = String(input).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
            if (!host) return "";
            return host.includes(":") ? "http://" + host : "http://" + host + ":" + DEFAULT_PORT;
        }
    }

    /* Ensures the DTGCommKey header is formatted properly for game API authorization */
    function normalizeHeaders(desiredHeader) {
        if (!desiredHeader) return {};
        if (typeof desiredHeader === "string") {
            return { DTGCommKey: desiredHeader.trim() };
        }
        return Object.assign({}, desiredHeader);
    }

    /* Configures the active connection endpoint, clears cached telemetry and stores credentials */
    function setCurrentComputer(desiredURL, desiredHeader) {
        baseUrl = normalizeBaseUrl(desiredURL);
        headers = normalizeHeaders(desiredHeader);

        Object.keys(_last_known).forEach(function (k) {
            delete _last_known[k];
        });
        oldSpeed = null;
        newSpeed = null;
        lastSpeedUpdateTime = null;
        _smoothedAcceleration = 0.0;

        try {
            const apiKey = headers.DTGCommKey || headers.dtgcommkey || "";
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({
                    ipAddress: String(desiredURL || "").trim(),
                    apiKey: apiKey,
                    baseUrl: baseUrl
                })
            );
        } catch (err) {
        }
    }

    /* Retrieves currently stored active connection details from browser storage */
    function getActiveConnection() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (err) {
            return null;
        }
    }

    /* Clears the active connection configuration and memory state */
    function clearActiveConnection() {
        baseUrl = "";
        headers = {};
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (err) {
        }
    }

    /* Extension bridge constants and sequence state for message routing */
    const EXT_PAGE_SOURCE = "tsw6ti-page";
    const EXT_BRIDGE_SOURCE = "tsw6ti-ext";
    const _pendingExtRequests = new Map();
    let _extRequestSeq = 0;
    let _extListenerAttached = false;

    /* Checks if the TSW6Ti browser extension content script has marked the DOM */
    function hasExtensionBridge() {
        return typeof document !== "undefined" &&
            Boolean(document.documentElement) &&
            document.documentElement.dataset.tsw6Ext === "1";
    }

    /* Attaches the message listener handling responses forwarded by the browser extension */
    function ensureExtensionListener() {
        if (_extListenerAttached || typeof window === "undefined") {
            return;
        }
        _extListenerAttached = true;
        window.addEventListener("message", function (event) {
            if (event.source !== window || event.origin !== window.location.origin) {
                return;
            }
            const msg = event.data;
            if (!msg || msg.source !== EXT_BRIDGE_SOURCE || msg.type !== "FETCH_RESULT" || !msg.requestId) {
                return;
            }
            const pending = _pendingExtRequests.get(msg.requestId);
            if (!pending) {
                return;
            }
            _pendingExtRequests.delete(msg.requestId);
            clearTimeout(pending.timer);

            if (!msg.ok) {
                pending.reject(new Error(msg.error || "Extension request failed"));
                return;
            }

            const status = Number(msg.status || 0);
            pending.resolve({
                status: status,
                ok: status >= 200 && status < 300,
                json: async function () {
                    return msg.data;
                }
            });
        });
    }

    /* Sends HTTP requests across window messages to bypass browser mixed-content restrictions */
    function fetchViaExtension(url, options, timeoutMs) {
        ensureExtensionListener();
        const requestId = `tsw6_${++_extRequestSeq}_${Date.now()}`;
        const effectiveTimeout = Math.max(Number(timeoutMs) || 1000, 100);

        return new Promise(function (resolve, reject) {
            const timer = setTimeout(function () {
                _pendingExtRequests.delete(requestId);
                reject(new Error("TSW6 extension request timed out"));
            }, effectiveTimeout + 250);

            _pendingExtRequests.set(requestId, {
                resolve: resolve,
                reject: reject,
                timer: timer
            });

            window.postMessage(
                {
                    source: EXT_PAGE_SOURCE,
                    type: "FETCH",
                    requestId: requestId,
                    url: url,
                    method: (options && options.method) || "GET",
                    headers: (options && options.headers) || {},
                    timeoutMs: effectiveTimeout
                },
                window.location.origin
            );
        });
    }

    /* Dispatches fetch requests with a timeout, delegating to the extension if installed */
    async function fetchWithTimeout(url, options, timeoutMs) {
        if (hasExtensionBridge()) {
            return fetchViaExtension(url, options, timeoutMs);
        }

        const controller = new AbortController();
        const timer = setTimeout(function () {
            controller.abort();
        }, timeoutMs);

        try {
            const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
            return response;
        } finally {
            clearTimeout(timer);
        }
    }

    /* Simple promise-based delay helper */
    function sleep(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    /* Queries a TSW6 API endpoint with automatic retries and fallback to last-known data */
    async function makeQuery(path, retries = 1) {
        if (!baseUrl) {
            return null;
        }

        const cleanPath = String(path).replace(/^\/+/, "");

        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                const response = await fetchWithTimeout(
                    `${baseUrl}/${cleanPath}`,
                    {
                        method: "GET",
                        headers: headers
                    },
                    500
                );

                if (response.status === 200) {
                    const data = await response.json();
                    _last_known[cleanPath] = data;
                    return data;
                } else {
                    return _last_known[cleanPath] !== undefined ? _last_known[cleanPath] : null;
                }
            } catch (err) {
            }

            if (attempt < retries - 1) {
                await sleep(100);
            }
        }

        return _last_known[cleanPath] !== undefined ? _last_known[cleanPath] : null;
    }

    /* Verifies game connectivity by testing an unauthenticated TimeOfDay request with DTGCommKey */
    async function testConnection(ipAddress, apiKey, timeoutMs = 8000) {
        const targetBaseUrl = normalizeBaseUrl(ipAddress);
        const targetHeaders = normalizeHeaders(apiKey);

        if (!targetBaseUrl || !targetHeaders.DTGCommKey) {
            return { ok: false, message: "Missing IP address or API key" };
        }

        try {
            const response = await fetchWithTimeout(
                `${targetBaseUrl}/get/TimeOfDay.Data`,
                {
                    method: "GET",
                    headers: targetHeaders
                },
                timeoutMs
            );

            if (response.status === 401 || response.status === 403) {
                return { ok: false, message: "Invalid API key rejected by TSW6" };
            }

            if (response.status !== 200) {
                return { ok: false, message: `TSW6 returned HTTP ${response.status}` };
            }

            const data = await response.json();
            return { ok: true, data: data, baseUrl: targetBaseUrl };
        } catch (err) {
            console.error("[TSW6] Connection attempt failed:", err);
            if (!hasExtensionBridge() &&
                typeof window !== "undefined" &&
                window.location.protocol === "https:" &&
                targetBaseUrl.startsWith("http://")) {
                return {
                    ok: false,
                    message: `Browser blocked HTTPS -> HTTP connection to ${targetBaseUrl}. Install/enable the TSW6Ti Local Connector browser extension and ensure TSW6 is running with -HTTPAPI.`
                };
            }
            return {
                ok: false,
                message: (err && err.message)
                    ? `Could not connect to TSW6 at ${targetBaseUrl}: ${err.message}`
                    : `Could not connect to TSW6 at ${targetBaseUrl}. Ensure the game is running with -HTTPAPI.`
            };
        }
    }

    /* Tests and establishes the active game connection */
    async function connect(ipAddress, apiKey) {
        const check = await testConnection(ipAddress, apiKey);
        if (!check.ok) {
            return check;
        }
        setCurrentComputer(ipAddress, { DTGCommKey: String(apiKey).trim() });
        return {
            ok: true,
            baseUrl: baseUrl,
            data: check.data
        };
    }

    /* Queries current vehicle speed and converts from metres per second to miles per hour */
    async function getCurrentSpeed() {
        const data = await makeQuery("get/CurrentDrivableActor.Function.HUD_GetSpeed");

        if (!data) {
            return null;
        }

        let speed = data.Values;

        if (Array.isArray(speed) && speed.length > 0) {
            speed = speed[0];
        }

        if (speed !== null && typeof speed === "object") {
            const keys = ["Speed (ms)", "Speed", "Value"];
            for (let i = 0; i < keys.length; i++) {
                if (keys[i] in speed) {
                    speed = speed[keys[i]];
                    break;
                }
            }
        }

        if (typeof speed === "number" && !Number.isNaN(speed)) {
            newSpeed = speed;
            if (oldSpeed === null) {
                oldSpeed = speed;
                lastSpeedUpdateTime = new Date();
            }
            const speedMph = speed * 2.236936;
            return speedMph.toFixed(2);
        }

        newSpeed = speed;
        lastSpeedUpdateTime = new Date();

        return String(speed);
    }

    /* Calculates smoothed acceleration in metres per second squared from consecutive speed updates */
    function getCurrentAcceleration() {
        if (
            typeof newSpeed === "number" &&
            lastSpeedUpdateTime !== null &&
            typeof oldSpeed === "number"
        ) {
            const now = new Date();
            const timeDiff = (now.getTime() - lastSpeedUpdateTime.getTime()) / 1000.0;
            if (timeDiff > 0) {
                const rawAccel = (newSpeed - oldSpeed) / timeDiff;
                oldSpeed = newSpeed;
                lastSpeedUpdateTime = now;

                if (timeDiff > 3.0) {
                    _smoothedAcceleration = rawAccel;
                } else {
                    _smoothedAcceleration =
                        _accelAlpha * rawAccel + (1.0 - _accelAlpha) * _smoothedAcceleration;
                }

                if (Math.abs(_smoothedAcceleration) < 0.01) {
                    _smoothedAcceleration = 0.0;
                }

                return `${_smoothedAcceleration.toFixed(2)} m/s²`;
            }
        }
        return "N/A";
    }

    /* Queries the current posted track speed limit from DriverAid data */
    async function getCurrentSpeedLimit() {
        const data = await makeQuery("get/DriverAid.Data");

        if (!data) {
            return "N/A";
        }

        try {
            const speedLimitMS =
                data.Values && data.Values.speedLimit ? data.Values.speedLimit.value : undefined;

            if (typeof speedLimitMS === "number") {
                if (speedLimitMS > 1000) {
                    return "None";
                }

                const speedLimitMPH = speedLimitMS * 2.236936;
                return speedLimitMPH.toFixed(2);
            }
        } catch (err) {
        }

        return "N/A";
    }

    /* Formats a JavaScript Date object into a readable YYYY-MM-DD HH:MM:SS string */
    function formatDateTime(dt) {
        const pad = function (n) {
            return String(n).padStart(2, "0");
        };
        return (
            dt.getFullYear() +
            "-" +
            pad(dt.getMonth() + 1) +
            "-" +
            pad(dt.getDate()) +
            " " +
            pad(dt.getHours()) +
            ":" +
            pad(dt.getMinutes()) +
            ":" +
            pad(dt.getSeconds())
        );
    }

    /* Queries in-game simulation time of day from TimeOfDay.Data */
    async function getCurrentDateTime() {
        const data = await makeQuery("get/TimeOfDay.Data");

        if (!data) {
            return "N/A (Connection failed)";
        }

        if (data.Result !== "Success") {
            return `N/A (API Error: ${data.Message || "Unknown"})`;
        }

        try {
            const values = data.Values || {};
            const isoStr = values.LocalTimeISO8601;

            if (isoStr) {
                const dt = new Date(isoStr);
                if (Number.isNaN(dt.getTime())) {
                    return "N/A (Parse Error: Invalid ISO date)";
                }
                return formatDateTime(dt);
            } else {
                return "N/A (ISO String missing from payload)";
            }
        } catch (err) {
            return `N/A (Parse Error: ${err.message || err})`;
        }
    }

    /* Parses the train object class string into a clean, human-friendly locomotive name */
    async function getTrainName() {
        const data = await makeQuery("get/CurrentFormation/0.ObjectClass");

        if (!data) {
            return "N/A";
        }

        try {
            const objectClass = (data.Values && data.Values.ObjectClass) || "";

            if (objectClass) {
                let cleanName = objectClass.replace(/^RVM_/, "");
                cleanName = cleanName.replace(/_[A-Z0-9]$/, "");

                const parts = cleanName.split("_");

                if (
                    parts.length >= 3 &&
                    parts[0].length === 3 &&
                    parts[0] === parts[0].toUpperCase() &&
                    parts[1] === parts[1].toUpperCase()
                ) {
                    parts.shift();
                }

                const formattedParts = parts.map(function (p) {
                    return p.replace(/^class(\d+)/i, "Class $1");
                });

                return formattedParts.join(" ");
            }
        } catch (err) {
        }

        return "Unknown";
    }

    /* Retrieves current train GPS coordinates (latitude and longitude) */
    async function getCurrentTrainCoordinates() {
        const data = await makeQuery("get/DriverAid.PlayerInfo");

        if (!data) {
            return null;
        }

        try {
            const geo = data.Values.geoLocation;
            if (!geo) return null;

            return {
                latitude: geo.latitude,
                longitude: geo.longitude
            };
        } catch (err) {
            return null;
        }
    }

    /* Queries current throttle lever percentage */
    async function getThrottleLevel() {
        const data = await makeQuery(
            "get/CurrentDrivableActor/Throttle_IrregularLever.InputValue"
        );

        if (!data || data.Result !== "Success") {
            return null;
        }

        try {
            const val = parseFloat(
                data.Values && data.Values.InputValue !== undefined ? data.Values.InputValue : 0.0
            );
            return Number.isNaN(val) ? null : val;
        } catch (err) {
            return null;
        }
    }

    /* Queries current train brake lever percentage */
    async function getBrakeLevel() {
        const data = await makeQuery(
            "get/CurrentDrivableActor/TrainBrake_IrregularLever.InputValue"
        );

        if (!data || data.Result !== "Success") {
            return null;
        }

        try {
            const val = parseFloat(
                data.Values && data.Values.InputValue !== undefined ? data.Values.InputValue : 0.0
            );
            return Number.isNaN(val) ? null : val;
        } catch (err) {
            return null;
        }
    }

    /* Queries reverser position lever value */
    async function getReverserLevel() {
        const data = await makeQuery(
            "get/CurrentDrivableActor/Reverser_IrregularLever.InputValue"
        );

        if (!data || data.Result !== "Success") {
            return null;
        }

        try {
            const val = parseFloat(
                data.Values && data.Values.InputValue !== undefined ? data.Values.InputValue : 0.0
            );
            return Number.isNaN(val) ? null : val;
        } catch (err) {
            return null;
        }
    }

    /* Sends a PATCH request to adjust the locomotive throttle lever in-game */
    async function setThrottle(percentage) {
        if (!baseUrl) return false;
        const clamped = Math.max(0.0, Math.min(100.0, Number(percentage)));
        const apiValue = clamped / 100.0;
        const patchUrl = `${baseUrl}/set/CurrentDrivableActor/Throttle_IrregularLever.InputValue?Value=${apiValue}`;

        try {
            const response = await fetchWithTimeout(
                patchUrl,
                {
                    method: "PATCH",
                    headers: headers
                },
                2000
            );
            if (response.status === 200) {
                const data = await response.json();
                if (data && data.Result === "Success") {
                    console.log(`Throttle set to ${clamped}% (API sent: ${apiValue.toFixed(3)})`);
                    return true;
                }
            }
            console.warn("Failed to set throttle.");
            return false;
        } catch (err) {
            console.error("Network error:", err);
            return false;
        }
    }

    /* Sends a PATCH request to adjust the train brake lever in-game */
    async function setBrake(percentage) {
        if (!baseUrl) return false;
        const clamped = Math.max(0.0, Math.min(100.0, Number(percentage)));
        const apiValue = clamped / 100.0;
        const patchUrl = `${baseUrl}/set/CurrentDrivableActor/TrainBrake_IrregularLever.InputValue?Value=${apiValue}`;

        try {
            const response = await fetchWithTimeout(
                patchUrl,
                {
                    method: "PATCH",
                    headers: headers
                },
                2000
            );
            if (response.status === 200) {
                const data = await response.json();
                if (data && data.Result === "Success") {
                    console.log(`Brake set to ${clamped}% (API sent: ${apiValue.toFixed(3)})`);
                    return true;
                }
            }
            console.warn("Failed to set brake.");
            return false;
        } catch (err) {
            console.error("Network error:", err);
            return false;
        }
    }

    /* Queries environmental weather parameters like cloudiness, precipitation and temperature */
    async function getWeather() {
        const [
            cloudiness,
            precipitation,
            fog,
            temp,
            wetness,
            groundSnow,
            piledSnow
        ] = await Promise.all([
            makeQuery("get/WeatherManager.Cloudiness"),
            makeQuery("get/WeatherManager.Precipitation"),
            makeQuery("get/WeatherManager.FogDensity"),
            makeQuery("get/WeatherManager.Temperature"),
            makeQuery("get/WeatherManager.Wetness"),
            makeQuery("get/WeatherManager.GroundSnow"),
            makeQuery("get/WeatherManager.PiledSnow")
        ]);

        const readFloat = function (payload, key) {
            if (!payload || !payload.Values || payload.Values[key] === undefined) return 0.0;
            const v = parseFloat(payload.Values[key]);
            return Number.isNaN(v) ? 0.0 : v;
        };

        return {
            cloudiness: readFloat(cloudiness, "Cloudiness"),
            precipitation: readFloat(precipitation, "Precipitation"),
            fogDensity: readFloat(fog, "FogDensity"),
            temperature: readFloat(temp, "Temperature"),
            wetness: readFloat(wetness, "Wetness"),
            groundSnow: readFloat(groundSnow, "GroundSnow"),
            piledSnow: readFloat(piledSnow, "PiledSnow")
        };
    }

    /* Updates a specific weather parameter in-game via PATCH */
    async function setEnvironmentParam(param, value) {
        if (!baseUrl) return false;
        try {
            await fetchWithTimeout(
                `${baseUrl}/set/WeatherManager.${param}?Value=${encodeURIComponent(value)}`,
                {
                    method: "PATCH",
                    headers: headers
                },
                2000
            );
            return true;
        } catch (err) {
            console.error("Environment set network error:", err);
            return false;
        }
    }

    /* Restores previously active connection settings from local storage if available */
    const saved = getActiveConnection();
    if (saved && saved.ipAddress && saved.apiKey) {
        baseUrl = normalizeBaseUrl(saved.ipAddress);
        headers = normalizeHeaders(saved.apiKey);
    }

    /* Exposes the TSW6 API client methods on the global window object */
    window.TSW6 = {
        setCurrentComputer: setCurrentComputer,
        getActiveConnection: getActiveConnection,
        clearActiveConnection: clearActiveConnection,
        hasExtension: hasExtensionBridge,
        testConnection: testConnection,
        connect: connect,
        makeQuery: makeQuery,
        getCurrentSpeed: getCurrentSpeed,
        getCurrentAcceleration: getCurrentAcceleration,
        getCurrentSpeedLimit: getCurrentSpeedLimit,
        getCurrentDateTime: getCurrentDateTime,
        getTrainName: getTrainName,
        getCurrentTrainCoordinates: getCurrentTrainCoordinates,
        getThrottleLevel: getThrottleLevel,
        getBrakeLevel: getBrakeLevel,
        getReverserLevel: getReverserLevel,
        setThrottle: setThrottle,
        setBrake: setBrake,
        getWeather: getWeather,
        setEnvironmentParam: setEnvironmentParam
    };
})();
