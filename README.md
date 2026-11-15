# Train Sim World 6 Telemetry Interface

> A sleek, real-time telemetry dashboard and driver companion for Train Sim World 6. Because driving a 4,000-tonne freight train or flying down the mainline at 125 mph is much cooler when you have shiny live dials on your second screen.

![Visitor Count](https://komarev.com/ghpvc/?username=SherlockJomesBG-TSW6Ti&label=Project+Views)
---

## About this project

Welcome to **TSW6Ti** (Train Sim World 6 Telemetry Interface)! 

The goal here is simple: To turn your second monitor, laptop, or tablet (Android only at the moment) into a proper cab companion. Instead of cluttering your windscreen with HUD popups while trying to enjoy the scenic countryside, TSW6Ti pulls data live straight from the game and serves up responsive speedometers, acceleration traces, dynamic brake meters, live route progress, weather monitors, and recording replays. And on top of this, it's all in a customizable, modular grid.

### The Origin Story
This whole thing kicked off at **Hackabury 2026**! Fueled by far too much caffeine, a deep lack of sleep, and dedication to the cause, we built the prototype over the hackathon weekend. To our absolute delight, it ended up winning the **Dovetail Track Prize**! 

Since the hackathon, we've completely rebuilt the project changing the way in which it works on the backend, polished the dials, added persistent accounts and recordings, and built out a full-blown platform so the wider community can enjoy this project with us.

---

## Tech Stack & Architecture

Here is a quick look under the hood at what powers TSW6Ti:

- **Frontend Core:** Pure vanilla modern JavaScript (ES6+), zero heavy frontend frameworks (no React/Vue bloat), [Chart.js](https://www.chartjs.org/) for live telemetry traces, [SortableJS](https://sortablejs.github.io/Sortable/) for drag-and-drop dashboard modularity, and marked + DOMPurify for documentation parsing.
- **Backend Services:** Python 3 and [Flask](https://flask.palletsprojects.com/) serving a lightweight REST API and WSGI runtime, with [fpdf2](https://py-pdf.github.io/fpdf2/) generating downloadable PDF journey telemetry summary sheets.
- **Database & Persistence:** SQLite with parameterized queries, scrypt password hashing, session tokens, and authenticated HMAC-SHA256 CTR stream encryption for stored user API keys.
- **Browser Extension Bridge:** Manifest V3 WebExtension (Chromium-ready) bridging the secure `https://` web dashboard to your local Train Sim World 6 HTTP API port (`31270`) without any telemetry leaving your machine.
- **Edge Network & Deployment:** Zero-port [Cloudflare Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with edge TLS termination and WAF protection.

---

## Device Support & Compatibility

TSW6Ti is designed to turn your second monitor, laptop, or tablet into a dedicated in-cab companion. Because the interface communicates directly with your running Train Sim World 6 game over your local network, device compatibility is based on browser extension support:

### Desktop (Windows, macOS, Linux) — Fully Supported
- **Chromium-Based Browsers:** Full support across all major Chromium browsers, including **Google Chrome**, **Microsoft Edge**, **Opera**, **Vivaldi**, **Brave**, and other Chromium derivatives via our bridge extension.
- **Mozilla Firefox:** Not supported.

### Android Tablets & Phones — Supported
- Fully functional on Android through Chromium-based browsers that support developer extensions, such as:
  - **Vivaldi for Android**
  - **Microsoft Edge Canary** (with developer extension support enabled)
- This allows you to mount an Android tablet right next to your wheel, throttle, or desk and run it as an authentic digital cab telemetry display over your local Wi-Fi.

### iPads & iOS — No Support
- **iPads and iPhones currently have no support.** Apple's strict platform restrictions on iPadOS and iOS (mandatory WebKit engine enforcement and lack of extension sideloading for local network bridges) prevent the browser from connecting directly to your running game's local port (`31270`).

---

## Security of this project

We take your security and that of our server seriously. Nobody wants their telemetry system compromised, so we built this with strict zero-nonsense defaults:

- **Local-First Telemetry:** Your live driving data, IP addresses, and `DTGCommKey` credentials flow directly between your browser and your local gaming rig via our open-source browser connector. Your live driving telemetry never gets routed through, logged on, or snooped on by our servers.
- **Battle-Tested Server Core:** On the backend, we run strictly parameterised SQLite queries, cryptographic password hashing with scrypt, and authenticated encryption at rest for any saved connection keys.
- **Lockdown Headers & Rate Limiting:** We enforce a strict Content Security Policy (`CSP`), anti-framing protections, and aggressive rate limits on auth and contact endpoints to keep bots and bad actors out of the cab.
- **Payload Caps:** Requests are capped with a strict 16 MB ceiling so nobody can try to crash the server by uploading an entire digital locomotive manual.

---

## GDPR of this project

We genuinely despise sneaky tracking, predatory telemetry, and dark patterns as much as you do. You're here to drive and monitor trains, not be advertised to:

- **Zero Tracking Junk:** No third-party ad pixels, no tracking cookies, no Google Analytics stalking your cursor, and no selling data to sketchy brokers.
- **Only What’s Needed:** We only store the bare minimum required to make your account work: your username, your hashed password, and whichever custom dashboard layouts or run recordings you explicitly choose to save.
- **You Own Your Data:** Head over to your Account page at any time and you'll find genuine one-click GDPR buttons. You can export every single byte of your data in clean JSON, set automatic retention timers on your recordings, or hit the Delete Account button to purge yourself from the database completely and immediately. No hoops, no emails to support, no nonsense.

---

## AI Statement

Let's address the robot in the room! 🤖

**AI was used strictly and exclusively for generating and wrestling CSS styling — absolutely zero game communication, math, authentication, security, or core logic was handed over to an AI.**

Why? Because writing CSS by hand for five dozen responsive dashboard cards, glowing neon gauge borders, and dark mode theme variables across six breakpoints is an exercise in pure human suffering. Centering a `div` at 3 AM while questioning your life choices is something we happily offloaded to a large language model.

That said, every layout architecture, UI wireframe, design token, and aesthetic decision was completely structured, directed, reviewed, and wrangled by actual human hands. The core of this project is 100% human-coded.

---

## What we want to do next

We're just pulling out of the station! Here is what's on the roadmap:

- **More Dashboard Modules:** We want to add more optional modules for you to choose from for your dashboard. Any suggestions would be greatly appreciated via our [Contact Page](https://tsw6ti.com/contact)
- **Corporate Testing and Monitoring:** Allow companies using this project to record sessions and have more analytic tools. Again if anything in particular you would like to see please let us know via our [Contact Page](https://tsw6ti.com/contact)
- **Enhanced Cruise Control:** After our meeting with Dovetail Games shortly after Hackabury they tipped us off at a new approach we could take with our cruise control functionality. We are eager to get this new approach implemented and working.

---

## Disclaimer & License

### Disclaimer
*Train Sim World®* is a registered trademark of RailSimulator.com Limited ("Dovetail Games"). TSW6Ti is an independent community open-source project and is not officially affiliated with, endorsed by, or sponsored by Dovetail Games. All train, route, and brand names referenced belong to their respective copyright and trademark owners.

### License
This project is open-source and released under the **MIT License**. You are free to inspect, modify, and build upon this code for personal and non-commercial simulation use.
