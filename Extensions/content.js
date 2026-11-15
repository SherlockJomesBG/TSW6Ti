(function () {
    "use strict";

    const extApi = typeof browser !== "undefined" ? browser : chrome;
    const PAGE_SOURCE = "tsw6ti-page";
    const EXT_SOURCE = "tsw6ti-ext";

    function markExtensionReady() {
        if (document.documentElement) {
            document.documentElement.dataset.tsw6Ext = "1";
        }
    }

    markExtensionReady();
    if (!document.documentElement) {
        document.addEventListener("DOMContentLoaded", markExtensionReady, { once: true });
    }

    window.addEventListener("message", function (event) {
        if (event.source !== window || event.origin !== window.location.origin) {
            return;
        }

        const msg = event.data;
        if (!msg || msg.source !== PAGE_SOURCE || msg.type !== "FETCH" || !msg.requestId) {
            return;
        }

        const payload = {
            type: "TSW6_FETCH",
            url: msg.url,
            method: msg.method,
            headers: msg.headers,
            timeoutMs: msg.timeoutMs
        };

        try {
            extApi.runtime.sendMessage(payload, function (reply) {
                const lastErr = extApi.runtime.lastError;
                if (lastErr || !reply) {
                    window.postMessage(
                        {
                            source: EXT_SOURCE,
                            type: "FETCH_RESULT",
                            requestId: msg.requestId,
                            ok: false,
                            status: 0,
                            error: (lastErr && lastErr.message) || "Extension bridge failed"
                        },
                        window.location.origin
                    );
                    return;
                }

                window.postMessage(
                    {
                        source: EXT_SOURCE,
                        type: "FETCH_RESULT",
                        requestId: msg.requestId,
                        ok: Boolean(reply.ok),
                        status: Number(reply.status || 0),
                        data: reply.data,
                        error: reply.error || null
                    },
                    window.location.origin
                );
            });
        } catch (err) {
            window.postMessage(
                {
                    source: EXT_SOURCE,
                    type: "FETCH_RESULT",
                    requestId: msg.requestId,
                    ok: false,
                    status: 0,
                    error: (err && err.message) || "Extension messaging error"
                },
                window.location.origin
            );
        }
    });
})();

