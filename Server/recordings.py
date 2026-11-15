# Here lies the Python concerned with telemetry recordings, trip logging and report generation
# This handles route reconciliation, sample compression, archive persistence, analytical metrics and PDF export
# Remember consistency is key

import gzip
import json
import math
import os
import secrets
from datetime import datetime, timezone

# Calculates great-circle distance between two GPS coordinates in statute miles using the Haversine formula
def haversineMiles(lat1, lon1, lat2, lon2):
    r = 3958.8
    dLat = math.radians(lat2 - lat1)
    dLon = math.radians(lon2 - lon1)
    a = (
        math.sin(dLat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dLon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return r * c

# Validates that a sample has valid, finite geographic latitude and longitude coordinates
def _validCoord(sample):
    lat = sample.get("lat")
    lon = sample.get("lon")
    return (
        isinstance(lat, (int, float))
        and isinstance(lon, (int, float))
        and math.isfinite(lat)
        and math.isfinite(lon)
        and (abs(lat) > 0.0001 or abs(lon) > 0.0001)
    )

# Projects train coordinates onto a route polyline to find the closest segment and progress index
def _projectOnRoute(lat, lon, line):
    n = len(line)
    nearestIdx = 0
    nearestDist = float("inf")
    dists = []
    for i, st in enumerate(line):
        d = haversineMiles(lat, lon, st["lat"], st["lon"])
        dists.append(d)
        if d < nearestDist:
            nearestDist = d
            nearestIdx = i

    if n < 2:
        return 0, nearestIdx, nearestDist, nearestDist, float(nearestIdx)

    bestSeg = 0
    bestScore = float("inf")
    for i in range(n - 1):
        segLen = haversineMiles(
            line[i]["lat"], line[i]["lon"], line[i + 1]["lat"], line[i + 1]["lon"]
        )
        score = (dists[i] + dists[i + 1]) - segLen
        if score < bestScore:
            bestScore = score
            bestSeg = i

    d1 = dists[bestSeg]
    d2 = dists[bestSeg + 1]
    denom = d1 + d2
    frac = (d1 / denom) if denom > 1e-6 else 0.0
    frac = max(0.0, min(1.0, frac))
    progress = bestSeg + frac
    return bestSeg, nearestIdx, nearestDist, bestScore, progress

# Reconciles raw GPS samples against route networks to establish canonical route, direction and station events
def _reconcileRouteAndStations(samples, routesCatalog):
    if not routesCatalog or not samples:
        return {
            "routeID": None,
            "routeName": "Unknown Route",
            "direction": "forward",
            "originStation": "Unknown",
            "destinationStation": "Unknown",
            "terminusStation": "Unknown",
            "stationEvents": [],
            "reconciled": [],
        }

    # Votes on the canonical route based on proximity across all valid GPS fixes
    routeVotes = {}
    routeDistSums = {}
    routeMap = {r["routeID"]: r for r in routesCatalog if r.get("stations")}

    for s in samples:
        if not _validCoord(s):
            continue
        lat, lon = float(s["lat"]), float(s["lon"])
        bestRid = None
        bestScore = float("inf")
        bestNd = float("inf")
        for rid, route in routeMap.items():
            _, _, nd, score, _ = _projectOnRoute(lat, lon, route["stations"])
            if score < bestScore or (abs(score - bestScore) < 1e-6 and nd < bestNd):
                bestScore = score
                bestNd = nd
                bestRid = rid
        if bestRid is not None and bestNd <= 25.0:
            routeVotes[bestRid] = routeVotes.get(bestRid, 0) + 1
            routeDistSums[bestRid] = routeDistSums.get(bestRid, 0.0) + bestNd

    # Fallback to reported route ID when no GPS coordinate matches within range
    if not routeVotes:
        for s in samples:
            rid = s.get("routeID")
            if rid in routeMap:
                routeVotes[rid] = routeVotes.get(rid, 0) + 1
                routeDistSums[rid] = routeDistSums.get(rid, 0.0)

    if not routeVotes:
        return {
            "routeID": None,
            "routeName": "Unknown Route",
            "direction": "forward",
            "originStation": "Unknown",
            "destinationStation": "Unknown",
            "terminusStation": "Unknown",
            "stationEvents": [],
            "reconciled": [None] * len(samples),
        }

    canonicalRid = max(
        routeVotes.keys(),
        key=lambda rid: (routeVotes[rid], -routeDistSums.get(rid, 0.0)),
    )
    canonicalRoute = routeMap[canonicalRid]
    line = canonicalRoute["stations"]
    nStations = len(line)

    # Projects all recorded telemetry ticks onto the determined canonical route
    rawProj = []
    validProgress = []
    for idx, s in enumerate(samples):
        if _validCoord(s):
            lat, lon = float(s["lat"]), float(s["lon"])
            seg, nearIdx, nearDist, _, prog = _projectOnRoute(lat, lon, line)
            rawProj.append((lat, lon, seg, nearIdx, nearDist, prog))
            validProgress.append((idx, prog, nearIdx, nearDist, float(s.get("speedMph") or 0)))
        else:
            rawProj.append(None)

    # Smooths progression using median filtering across sliding windows to eliminate GPS jump artifacts
    smoothedProg = []
    rawProgOnly = [p[5] if p is not None else None for p in rawProj]
    halfWin = 3
    for i in range(len(samples)):
        if rawProgOnly[i] is None:
            smoothedProg.append(None)
            continue
        windowVals = [
            rawProgOnly[j]
            for j in range(max(0, i - halfWin), min(len(samples), i + halfWin + 1))
            if rawProgOnly[j] is not None
        ]
        windowVals.sort()
        smoothedProg.append(windowVals[len(windowVals) // 2])

    # Determines primary net travel direction across the entire recorded journey
    validSmoothed = [(i, p) for i, p in enumerate(smoothedProg) if p is not None]
    direction = "forward"
    if len(validSmoothed) >= 2:
        kEdge = max(1, min(10, len(validSmoothed) // 5))
        startMed = sorted([p for _, p in validSmoothed[:kEdge]])[kEdge // 2]
        endMed = sorted([p for _, p in validSmoothed[-kEdge:]])[kEdge // 2]
        deltaProg = endMed - startMed

        if abs(deltaProg) >= 0.015:
            direction = "forward" if deltaProg > 0 else "backward"
        else:
            # Handles stationary shunting by checking terminal endpoint proximity
            firstNear = validProgress[0][2]
            firstDist = validProgress[0][3]
            if firstNear == nStations - 1 and firstDist <= 0.25:
                direction = "backward"
            elif firstNear == 0 and firstDist <= 0.25:
                direction = "forward"
            else:
                dirVotes = {"forward": 0, "backward": 0}
                for s in samples:
                    d = s.get("direction")
                    if d in dirVotes:
                        dirVotes[d] += 1
                direction = "backward" if dirVotes["backward"] > dirVotes["forward"] else "forward"

    # Enforces monotonic progress along the canonical route direction with noise tolerance
    monoProg = list(smoothedProg)
    lastP = None
    for i in range(len(monoProg)):
        p = monoProg[i]
        if p is None:
            monoProg[i] = lastP
            continue
        if lastP is None:
            lastP = p
            continue
        if direction == "forward":
            if p < lastP - 0.08:
                monoProg[i] = lastP
            elif p > lastP:
                lastP = p
        else:
            if p > lastP + 0.08:
                monoProg[i] = lastP
            elif p < lastP:
                lastP = p

    # Computes stabilized previous and next station names and remaining distance for every tick
    reconciled = []
    for i, s in enumerate(samples):
        proj = rawProj[i]
        p = monoProg[i]
        if p is None or nStations < 2:
            reconciled.append({
                "routeID": canonicalRid,
                "routeName": canonicalRoute["routeName"],
                "direction": direction,
                "prevName": line[0]["name"] if line else "Unknown",
                "nextName": line[-1]["name"] if line else "Unknown",
                "distNextMi": 0.0,
            })
            continue

        seg = max(0, min(nStations - 2, int(math.floor(p))))
        stA = line[seg]
        stB = line[seg + 1]

        if direction == "forward":
            prevSt = stA
            nextSt = stB
            if proj is not None:
                dB = haversineMiles(proj[0], proj[1], stB["lat"], stB["lon"])
                if dB <= 0.03 and seg + 2 < nStations:
                    prevSt = stB
                    nextSt = line[seg + 2]
        else:
            prevSt = stB
            nextSt = stA
            if proj is not None:
                dA = haversineMiles(proj[0], proj[1], stA["lat"], stA["lon"])
                if dA <= 0.03 and seg - 1 >= 0:
                    prevSt = stA
                    nextSt = line[seg - 1]

        if proj is not None:
            coordKey = "forEnd" if direction == "forward" else "backEnd"
            targetCoord = nextSt.get(coordKey) or nextSt
            distNext = haversineMiles(proj[0], proj[1], targetCoord["lat"], targetCoord["lon"])
        else:
            distNext = 0.0

        reconciled.append({
            "routeID": canonicalRid,
            "routeName": canonicalRoute["routeName"],
            "direction": direction,
            "prevName": prevSt["name"],
            "nextName": nextSt["name"],
            "distNextMi": round(distNext, 3),
        })

    # Identifies trip origin, destination and ultimate terminus stations
    terminusStation = line[-1]["name"] if direction == "forward" else line[0]["name"]

    originStation = reconciled[0]["prevName"] if reconciled else line[0]["name"]
    if validProgress:
        firstIdx, _, firstNear, firstDist, _ = validProgress[0]
        if firstDist <= 0.25:
            originStation = line[firstNear]["name"]
        else:
            originStation = reconciled[firstIdx]["prevName"]

    destinationStation = reconciled[-1]["nextName"] if reconciled else terminusStation
    if validProgress:
        lastIdx, _, lastNear, lastDist, _ = validProgress[-1]
        if lastDist <= 0.25:
            destinationStation = line[lastNear]["name"]
        else:
            destinationStation = reconciled[lastIdx]["nextName"]

    # Reconciles station approach, passing and dwell events along the route
    stationEvents = []
    inStation = {}
    tZero = float(samples[0].get("t") or 0)
    for i, s in enumerate(samples):
        proj = rawProj[i]
        if proj is None:
            continue
        lat, lon = proj[0], proj[1]
        tSec = round(float(s.get("t") or (tZero + i * 1000)) - tZero) / 1000.0
        spd = float(s.get("speedMph") or 0.0)
        for stIdx, st in enumerate(line):
            d = haversineMiles(lat, lon, st["lat"], st["lon"])
            if d <= 0.14:
                if stIdx not in inStation:
                    inStation[stIdx] = {
                        "stationName": st["name"],
                        "position": st["position"],
                        "arrivedSec": max(0, int(round(tSec))),
                        "departedSec": max(0, int(round(tSec))),
                        "minDistMi": round(d, 3),
                        "minSpeedMph": spd,
                        "maxSpeedMph": spd,
                        "ticks": 1,
                    }
                else:
                    ev = inStation[stIdx]
                    ev["departedSec"] = max(0, int(round(tSec)))
                    ev["minDistMi"] = min(ev["minDistMi"], round(d, 3))
                    ev["minSpeedMph"] = min(ev["minSpeedMph"], spd)
                    ev["maxSpeedMph"] = max(ev["maxSpeedMph"], spd)
                    ev["ticks"] += 1

    orderedIndices = sorted(
        inStation.keys(),
        key=lambda idx: inStation[idx]["arrivedSec"],
    )
    for stIdx in orderedIndices:
        ev = inStation[stIdx]
        dwell = max(0, ev["departedSec"] - ev["arrivedSec"])
        status = "Stopped" if ev["minSpeedMph"] < 1.5 and dwell >= 3 else "Passed"
        stationEvents.append({
            "stationName": ev["stationName"],
            "arrivedSec": ev["arrivedSec"],
            "departedSec": ev["departedSec"],
            "dwellSec": dwell,
            "minSpeedMph": round(ev["minSpeedMph"], 1),
            "maxSpeedMph": round(ev["maxSpeedMph"], 1),
            "status": status,
        })

    return {
        "routeID": canonicalRid,
        "routeName": canonicalRoute["routeName"],
        "direction": direction,
        "originStation": originStation,
        "destinationStation": destinationStation,
        "terminusStation": terminusStation,
        "stationEvents": stationEvents,
        "reconciled": reconciled,
    }

# Reconciles trip telemetry, compresses samples with gzip and saves archive to disk
def reconcileAndSaveRecording(userID, payload, routesCatalog, recordingsDir):
    rawSamples = payload.get("samples") or []
    if not rawSamples:
        raise ValueError("Recording contains no telemetry samples")

    userDir = os.path.join(recordingsDir, str(userID))
    os.makedirs(userDir, exist_ok=True)

    recId = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_") + secrets.token_hex(3)

    routeInfo = _reconcileRouteAndStations(rawSamples, routesCatalog)
    reconciledList = routeInfo["reconciled"]

    # Builds lookup dictionaries for strings and weather data for compact JSON storage
    routeNamesDict = []
    routeLookup = {}
    stationNamesDict = []
    stationLookup = {}
    weatherDict = []
    weatherLookup = {}

    def idxFor(val, arr, lookup):
        key = val or ""
        if key not in lookup:
            lookup[key] = len(arr)
            arr.append(key)
        return lookup[key]

    def weatherIdxFor(w):
        if not isinstance(w, dict):
            w = {}
        norm = {
            "t": round(float(w.get("temperature") or 0), 1),
            "c": round(float(w.get("cloudiness") or 0), 2),
            "p": round(float(w.get("precipitation") or 0), 2),
            "w": round(float(w.get("wetness") or 0), 2),
            "gs": round(float(w.get("groundSnow") or 0), 2),
            "ps": round(float(w.get("piledSnow") or 0), 2),
            "f": round(float(w.get("fogDensity") or 0), 3),
        }
        sig = json.dumps(norm, sort_keys=True)
        if sig not in weatherLookup:
            weatherLookup[sig] = len(weatherDict)
            weatherDict.append(norm)
        return weatherLookup[sig]

    # Traverses raw samples to calculate statistics, distance, overspeed events and packed rows
    tStartMs = float(rawSamples[0].get("t") or 0)
    lastCoord = None
    totalDistMiles = 0.0
    topSpeedMph = 0.0
    movingSpeeds = []
    peakAccel = 0.0
    peakBrake = 0.0
    overspeedCount = 0
    wasOverspeed = False
    overspeedEvents = []
    activeOverspeed = None

    trainVotes = {}
    packedSamples = []

    for i, s in enumerate(rawSamples):
        tMs = float(s.get("t") or (tStartMs + i * 1000))
        tSec = max(0, int(round((tMs - tStartMs) / 1000.0)))
        simTime = str(s.get("simTime") or "")
        spd = round(float(s.get("speedMph") or 0.0), 2)
        lim = round(float(s.get("limitMph") or 0.0), 2)
        acc = round(float(s.get("accel") or 0.0), 3)
        thr = round(float(s["throttle"]), 3) if isinstance(s.get("throttle"), (int, float)) else None
        brk = round(float(s["brake"]), 3) if isinstance(s.get("brake"), (int, float)) else None

        lat = round(float(s["lat"]), 6) if _validCoord(s) else None
        lon = round(float(s["lon"]), 6) if _validCoord(s) else None

        if lat is not None and lon is not None:
            if lastCoord is not None:
                stepMi = haversineMiles(lastCoord[0], lastCoord[1], lat, lon)
                if 0.00012 < stepMi < 0.35:
                    totalDistMiles += stepMi
            lastCoord = (lat, lon)

        tName = str(s.get("trainName") or "").strip()
        if tName and tName not in ("Unknown", "N/A"):
            trainVotes[tName] = trainVotes.get(tName, 0) + 1

        if spd > topSpeedMph:
            topSpeedMph = spd
        if spd > 0.5:
            movingSpeeds.append(spd)
        if acc > peakAccel:
            peakAccel = acc
        if acc < -peakBrake:
            peakBrake = abs(acc)

        recTick = reconciledList[i] if i < len(reconciledList) else None
        rName = recTick["routeName"] if recTick else routeInfo["routeName"]
        prevName = recTick["prevName"] if recTick else routeInfo["originStation"]
        nextName = recTick["nextName"] if recTick else routeInfo["destinationStation"]
        distNext = recTick["distNextMi"] if recTick else 0.0

        isOver = lim > 0 and spd > lim
        if isOver and not wasOverspeed:
            overspeedCount += 1
            activeOverspeed = {
                "startSec": tSec,
                "endSec": tSec,
                "peakSpeedMph": spd,
                "limitMph": lim,
                "nearStation": nextName or prevName,
            }
        elif isOver and activeOverspeed is not None:
            activeOverspeed["endSec"] = tSec
            if spd > activeOverspeed["peakSpeedMph"]:
                activeOverspeed["peakSpeedMph"] = spd
        elif not isOver and activeOverspeed is not None:
            activeOverspeed["durationSec"] = max(1, activeOverspeed["endSec"] - activeOverspeed["startSec"] + 1)
            overspeedEvents.append(activeOverspeed)
            activeOverspeed = None
        wasOverspeed = isOver

        rIdx = idxFor(rName, routeNamesDict, routeLookup)
        prevIdx = idxFor(prevName, stationNamesDict, stationLookup)
        nextIdx = idxFor(nextName, stationNamesDict, stationLookup)
        wIdx = weatherIdxFor(s.get("weather"))

        packedSamples.append([
            tSec,
            simTime,
            spd,
            lim,
            acc,
            thr,
            brk,
            lat,
            lon,
            rIdx,
            prevIdx,
            nextIdx,
            distNext,
            wIdx,
        ])

    if activeOverspeed is not None:
        activeOverspeed["durationSec"] = max(1, activeOverspeed["endSec"] - activeOverspeed["startSec"] + 1)
        overspeedEvents.append(activeOverspeed)

    trainName = max(trainVotes.keys(), key=lambda k: trainVotes[k]) if trainVotes else "Unknown"
    avgSpeedMph = sum(movingSpeeds) / len(movingSpeeds) if movingSpeeds else 0.0
    durationSec = packedSamples[-1][0] if packedSamples else len(packedSamples)
    if durationSec == 0 and len(packedSamples) > 1:
        durationSec = len(packedSamples) - 1

    simStart = next((row[1] for row in packedSamples if row[1] and not row[1].startswith("N/A")), "")
    simEnd = next((row[1] for row in reversed(packedSamples) if row[1] and not row[1].startswith("N/A")), "")

    startedAt = str(payload.get("startedAt") or datetime.now(timezone.utc).isoformat())
    endedAt = str(payload.get("endedAt") or datetime.now(timezone.utc).isoformat())

    defaultTitle = f"{routeInfo['routeName']} ({routeInfo['originStation']} -> {routeInfo['destinationStation']})"
    title = str(payload.get("title") or "").strip() or defaultTitle

    meta = {
        "recordingID": recId,
        "title": title,
        "startedAt": startedAt,
        "endedAt": endedAt,
        "simStartTime": simStart,
        "simEndTime": simEnd,
        "durationSec": int(durationSec),
        "sampleCount": len(packedSamples),
        "trainName": trainName,
        "routeID": routeInfo["routeID"],
        "routeName": routeInfo["routeName"],
        "direction": routeInfo["direction"],
        "originStation": routeInfo["originStation"],
        "destinationStation": routeInfo["destinationStation"],
        "terminusStation": routeInfo["terminusStation"],
        "distanceMiles": round(totalDistMiles, 2),
        "topSpeedMph": round(topSpeedMph, 1),
        "avgSpeedMph": round(avgSpeedMph, 1),
        "peakAccel": round(peakAccel, 2),
        "peakBrake": round(peakBrake, 2),
        "overspeedCount": overspeedCount,
        "overspeedEvents": overspeedEvents,
        "stationEvents": routeInfo["stationEvents"],
    }

    archive = {
        "v": 1,
        "meta": meta,
        "dict": {
            "routes": routeNamesDict,
            "stations": stationNamesDict,
            "weathers": weatherDict,
        },
        "schema": [
            "t", "simTime", "spd", "lim", "acc", "thr", "brk",
            "lat", "lon", "rIdx", "prevIdx", "nextIdx", "distMi", "wIdx",
        ],
        "samples": packedSamples,
    }

    # Compresses the JSON archive payload using gzip and writes to user storage directory
    relPath = os.path.join(str(userID), f"{recId}.json.gz")
    absPath = os.path.join(recordingsDir, relPath)
    rawBytes = json.dumps(archive, separators=(",", ":")).encode("utf-8")
    compressed = gzip.compress(rawBytes, compresslevel=6)
    with open(absPath, "wb") as f:
        f.write(compressed)

    meta["filePath"] = relPath
    meta["fileSizeBytes"] = len(compressed)
    return meta

# Loads a compressed telemetry archive from disk and unpacks dictionary-encoded samples
def loadRecordingArchive(absPath):
    with open(absPath, "rb") as f:
        compressed = f.read()
    archive = json.loads(gzip.decompress(compressed).decode("utf-8"))
    meta = archive.get("meta", {})
    dicts = archive.get("dict", {})
    routesD = dicts.get("routes", [])
    stationsD = dicts.get("stations", [])
    weathersD = dicts.get("weathers", [])

    expanded = []
    for row in archive.get("samples", []):
        w = weathersD[row[13]] if row[13] < len(weathersD) else {}
        expanded.append({
            "t": row[0],
            "simTime": row[1],
            "speedMph": row[2],
            "limitMph": row[3],
            "accel": row[4],
            "throttle": row[5],
            "brake": row[6],
            "lat": row[7],
            "lon": row[8],
            "routeName": routesD[row[9]] if row[9] < len(routesD) else meta.get("routeName", "Unknown"),
            "prevStation": stationsD[row[10]] if row[10] < len(stationsD) else "",
            "nextStation": stationsD[row[11]] if row[11] < len(stationsD) else "",
            "distNextMi": row[12],
            "weather": {
                "temperature": w.get("t", 0),
                "cloudiness": w.get("c", 0),
                "precipitation": w.get("p", 0),
                "wetness": w.get("w", 0),
                "groundSnow": w.get("gs", 0),
                "piledSnow": w.get("ps", 0),
                "fogDensity": w.get("f", 0),
            },
        })

    return {"meta": meta, "samples": expanded}

# Formats seconds into human-readable hours, minutes and seconds
def _fmtDuration(sec):
    sec = max(0, int(sec or 0))
    h = sec // 3600
    m = (sec % 3600) // 60
    s = sec % 60
    if h > 0:
        return f"{h}h {m:02d}m {s:02d}s"
    return f"{m}m {s:02d}s"

# Sanitises text strings to ASCII/latin-1 encoding safe for standard PDF fonts
def _ascii(text):
    return str(text or "").encode("latin-1", "replace").decode("latin-1")

# Generates a multi-page vector PDF report with charts, metrics and incident tables using fpdf2
def generateRecordingPdf(archiveData):
    from fpdf import FPDF

    meta = archiveData["meta"]
    samples = archiveData["samples"]

    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=14)
    pdf.add_page()

    # Draws report header banner and journey title
    pdf.set_fill_color(24, 12, 46)
    pdf.rect(0, 0, 210, 32, style="F")
    pdf.set_fill_color(139, 61, 255)
    pdf.rect(0, 32, 210, 1.2, style="F")

    pdf.set_xy(14, 7)
    pdf.set_font("Helvetica", "B", 16)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(0, 8, _ascii("TSW6 TELEMETRY RECORDING REPORT"), ln=1)

    pdf.set_x(14)
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(214, 208, 227)
    routeLine = f"{meta.get('routeName', 'Unknown Route')}  |  {meta.get('originStation', '?')} -> {meta.get('destinationStation', '?')}"
    pdf.cell(0, 6, _ascii(routeLine), ln=1)

    pdf.set_x(14)
    pdf.set_font("Helvetica", "", 8.5)
    pdf.set_text_color(167, 139, 250)
    subLine = f"Train: {meta.get('trainName', 'Unknown')}   |   Terminus: {meta.get('terminusStation', '—')}   |   Recorded: {str(meta.get('startedAt', ''))[:19].replace('T', ' ')} UTC"
    pdf.cell(0, 5, _ascii(subLine), ln=1)

    # Draws key performance indicators summary cards
    pdf.set_y(40)
    kpis = [
        ("DURATION", _fmtDuration(meta.get("durationSec", 0))),
        ("DISTANCE", f"{meta.get('distanceMiles', 0):.2f} mi"),
        ("TOP SPEED", f"{meta.get('topSpeedMph', 0):.1f} mph"),
        ("AVG SPEED", f"{meta.get('avgSpeedMph', 0):.1f} mph"),
        ("PEAK ACCEL", f"{meta.get('peakAccel', 0):.2f} m/s^2"),
        ("PEAK BRAKE", f"{meta.get('peakBrake', 0):.2f} m/s^2"),
        ("OVERSPEEDS", str(meta.get("overspeedCount", 0))),
        ("SAMPLES", str(meta.get("sampleCount", len(samples)))),
    ]

    cardW = 43.5
    cardH = 15
    gap = 2.6
    startX = 14
    for idx, (label, val) in enumerate(kpis):
        col = idx % 4
        row = idx // 4
        x = startX + col * (cardW + gap)
        y = 40 + row * (cardH + 3)
        pdf.set_fill_color(246, 244, 252)
        pdf.set_draw_color(210, 200, 235)
        pdf.rect(x, y, cardW, cardH, style="DF")
        pdf.set_xy(x + 2.5, y + 2)
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_text_color(108, 70, 180)
        pdf.cell(cardW - 5, 4, _ascii(label), ln=1)
        pdf.set_x(x + 2.5)
        pdf.set_font("Helvetica", "B", 11)
        pdf.set_text_color(25, 18, 42)
        pdf.cell(cardW - 5, 7, _ascii(val))

    # Draws vector speed versus track limit profile line chart
    yChart = 78
    pdf.set_xy(14, yChart)
    pdf.set_font("Helvetica", "B", 10.5)
    pdf.set_text_color(30, 20, 52)
    pdf.cell(0, 6, "Speed vs Track Speed Limit Profile (MPH)", ln=1)

    cx, cy, cw, ch = 22, yChart + 8, 174, 46
    pdf.set_fill_color(250, 249, 253)
    pdf.set_draw_color(215, 210, 228)
    pdf.rect(cx, cy, cw, ch, style="DF")

    maxSpd = max(
        [20.0] + [float(s.get("speedMph") or 0) for s in samples] + [float(s.get("limitMph") or 0) for s in samples]
    )
    yTop = math.ceil(maxSpd / 20.0) * 20.0

    # Grid tick lines
    pdf.set_font("Helvetica", "", 7)
    pdf.set_text_color(110, 105, 125)
    for step in range(0, 5):
        gy = cy + ch - (step / 4.0) * ch
        pdf.set_draw_color(230, 226, 240)
        pdf.line(cx, gy, cx + cw, gy)
        lbl = f"{int(round((step / 4.0) * yTop))}"
        pdf.text(cx - 8, gy + 1.2, lbl)

    if len(samples) >= 2:
        stepSkip = max(1, len(samples) // 350)
        pts = samples[::stepSkip]
        if pts[-1] is not samples[-1]:
            pts.append(samples[-1])
        totalT = max(1.0, float(samples[-1]["t"] or len(samples) - 1))

        # Speed limit line in amber
        pdf.set_draw_color(245, 158, 11)
        pdf.set_line_width(0.45)
        for j in range(len(pts) - 1):
            l1 = float(pts[j].get("limitMph") or 0)
            l2 = float(pts[j + 1].get("limitMph") or 0)
            if l1 <= 0 or l2 <= 0:
                continue
            x1 = cx + (float(pts[j]["t"]) / totalT) * cw
            x2 = cx + (float(pts[j + 1]["t"]) / totalT) * cw
            y1 = cy + ch - (min(l1, yTop) / yTop) * ch
            y2 = cy + ch - (min(l2, yTop) / yTop) * ch
            pdf.line(x1, y1, x2, y2)

        # Actual train speed in purple, red during overspeed
        pdf.set_line_width(0.6)
        for j in range(len(pts) - 1):
            s1 = float(pts[j].get("speedMph") or 0)
            s2 = float(pts[j + 1].get("speedMph") or 0)
            lim2 = float(pts[j + 1].get("limitMph") or 0)
            if lim2 > 0 and s2 > lim2:
                pdf.set_draw_color(225, 29, 72)
            else:
                pdf.set_draw_color(124, 42, 232)
            x1 = cx + (float(pts[j]["t"]) / totalT) * cw
            x2 = cx + (float(pts[j + 1]["t"]) / totalT) * cw
            y1 = cy + ch - (min(s1, yTop) / yTop) * ch
            y2 = cy + ch - (min(s2, yTop) / yTop) * ch
            pdf.line(x1, y1, x2, y2)
        pdf.set_line_width(0.2)

    # Draws acceleration and braking force profile chart
    yAcc = cy + ch + 10
    pdf.set_xy(14, yAcc)
    pdf.set_font("Helvetica", "B", 10.5)
    pdf.set_text_color(30, 20, 52)
    pdf.cell(0, 6, "Acceleration & Braking Profile (m/s^2)", ln=1)

    acy, ach = yAcc + 8, 36
    pdf.set_fill_color(250, 249, 253)
    pdf.set_draw_color(215, 210, 228)
    pdf.rect(cx, acy, cw, ach, style="DF")

    maxAcc = max([1.0] + [abs(float(s.get("accel") or 0)) for s in samples])
    accScale = max(1.0, math.ceil(maxAcc * 2.0) / 2.0)
    zeroY = acy + ach / 2.0
    pdf.set_draw_color(180, 175, 195)
    pdf.line(cx, zeroY, cx + cw, zeroY)
    pdf.set_font("Helvetica", "", 7)
    pdf.set_text_color(110, 105, 125)
    pdf.text(cx - 9, acy + 3, f"+{accScale:.1f}")
    pdf.text(cx - 7, zeroY + 1, "0.0")
    pdf.text(cx - 9, acy + ach - 1, f"-{accScale:.1f}")

    if len(samples) >= 2:
        stepSkip = max(1, len(samples) // 350)
        pts = samples[::stepSkip]
        if pts[-1] is not samples[-1]:
            pts.append(samples[-1])
        totalT = max(1.0, float(samples[-1]["t"] or len(samples) - 1))
        pdf.set_line_width(0.5)
        for j in range(len(pts) - 1):
            a1 = float(pts[j].get("accel") or 0)
            a2 = float(pts[j + 1].get("accel") or 0)
            if (a1 + a2) >= 0:
                pdf.set_draw_color(16, 185, 129)
            else:
                pdf.set_draw_color(225, 29, 72)
            x1 = cx + (float(pts[j]["t"]) / totalT) * cw
            x2 = cx + (float(pts[j + 1]["t"]) / totalT) * cw
            y1 = zeroY - max(-1.0, min(1.0, a1 / accScale)) * (ach / 2.0)
            y2 = zeroY - max(-1.0, min(1.0, a2 / accScale)) * (ach / 2.0)
            pdf.line(x1, y1, x2, y2)
        pdf.set_line_width(0.2)

    # Draws reconciled station stops and passing log table
    pdf.set_y(acy + ach + 10)
    pdf.set_font("Helvetica", "B", 10.5)
    pdf.set_text_color(30, 20, 52)
    pdf.cell(0, 7, "Reconciled Station Log", ln=1)

    events = meta.get("stationEvents") or []
    if not events:
        pdf.set_font("Helvetica", "I", 9)
        pdf.set_text_color(110, 105, 125)
        pdf.cell(0, 6, "No station approaches recorded along this route segment.", ln=1)
    else:
        colWidths = [70, 26, 26, 22, 38]
        headers = ["Station", "Arrived", "Departed", "Dwell", "Status"]
        pdf.set_fill_color(235, 228, 248)
        pdf.set_draw_color(205, 195, 225)
        pdf.set_font("Helvetica", "B", 8)
        pdf.set_text_color(45, 25, 80)
        pdf.set_x(14)
        for w, h in zip(colWidths, headers):
            pdf.cell(w, 7, h, border=1, fill=True)
        pdf.ln()

        pdf.set_font("Helvetica", "", 8)
        pdf.set_text_color(35, 30, 48)
        for ev in events:
            pdf.set_x(14)
            pdf.cell(colWidths[0], 6.5, _ascii(ev.get("stationName", "")), border=1)
            pdf.cell(colWidths[1], 6.5, _fmtDuration(ev.get("arrivedSec", 0)), border=1)
            pdf.cell(colWidths[2], 6.5, _fmtDuration(ev.get("departedSec", 0)), border=1)
            pdf.cell(colWidths[3], 6.5, f"{ev.get('dwellSec', 0)}s", border=1)
            pdf.cell(colWidths[4], 6.5, _ascii(ev.get("status", "")), border=1)
            pdf.ln()

    # Draws overspeed violation incidents log table
    overEvents = meta.get("overspeedEvents") or []
    pdf.ln(5)
    pdf.set_x(14)
    pdf.set_font("Helvetica", "B", 10.5)
    pdf.set_text_color(30, 20, 52)
    pdf.cell(0, 7, f"Overspeed Incidents ({len(overEvents)})", ln=1)

    if not overEvents:
        pdf.set_x(14)
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(22, 130, 90)
        pdf.cell(0, 6, "Clean run: zero speed limit violations recorded.", ln=1)
    else:
        colWidths = [32, 24, 28, 28, 70]
        headers = ["Time Window", "Duration", "Peak Speed", "Limit", "Nearest Station"]
        pdf.set_fill_color(254, 226, 226)
        pdf.set_draw_color(240, 180, 190)
        pdf.set_font("Helvetica", "B", 8)
        pdf.set_text_color(153, 27, 27)
        pdf.set_x(14)
        for w, h in zip(colWidths, headers):
            pdf.cell(w, 7, h, border=1, fill=True)
        pdf.ln()

        pdf.set_font("Helvetica", "", 8)
        pdf.set_text_color(35, 30, 48)
        for ev in overEvents:
            pdf.set_x(14)
            winStr = f"{_fmtDuration(ev.get('startSec', 0))} - {_fmtDuration(ev.get('endSec', 0))}"
            pdf.cell(colWidths[0], 6.5, winStr, border=1)
            pdf.cell(colWidths[1], 6.5, f"{ev.get('durationSec', 1)}s", border=1)
            pdf.cell(colWidths[2], 6.5, f"{ev.get('peakSpeedMph', 0):.1f} mph", border=1)
            pdf.cell(colWidths[3], 6.5, f"{ev.get('limitMph', 0):.0f} mph", border=1)
            pdf.cell(colWidths[4], 6.5, _ascii(ev.get("nearStation", "")), border=1)
            pdf.ln()

    out = pdf.output()
    if isinstance(out, str):
        return out.encode("latin-1")
    return bytes(out)

# Backwards compatibility function aliases
reconcile_and_save_recording = reconcileAndSaveRecording
load_recording_archive = loadRecordingArchive
generate_recording_pdf = generateRecordingPdf
haversine_miles = haversineMiles
