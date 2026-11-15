# Here lies the Python concerned with parsing and rendering legal documents
# This handles Microsoft Word (.docx) document extraction, sanitisation, table rendering, heading generation and document downloads
# Remember consistency is key

import html
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

from markupsafe import Markup

# OpenXML namespace definitions for WordprocessingML, relationships and Dublin Core properties
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
DCTERMS_NS = "http://purl.org/dc/terms/"

# Regex patterns for safe link schemes and automatic URL detection
SAFE_LINK_RE = re.compile(r"^(https?://|mailto:|/)", re.IGNORECASE)
AUTO_LINK_RE = re.compile(
    r"(https?://[^\s<>\"')]+|/(?:account|contact|privacy-policy|terms-and-conditions|settings)(?![A-Za-z0-9_/-]))"
)

# Supported heading styles and corresponding HTML heading level mappings
HEADING_STYLES = {
    "Heading1": 2,
    "Heading2": 3,
    "Heading3": 4,
    "Heading4": 4,
}

# OpenXML numbering formats that represent ordered lists
ORDERED_FORMATS = {"decimal", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman"}

# Master catalogue of supported legal document metadata and candidate filenames
LEGAL_DOCUMENTS = {
    "privacy-policy": {
        "slug": "privacy-policy",
        "title": "Privacy Policy",
        "subtitle": "How TSW6Ti collects, uses, secures, and manages your personal and telemetry data.",
        "badge": "UK GDPR & Privacy",
        "icon": "fa-solid fa-shield-halved",
        "filenames": [
            "TSW6Ti Privacy Policy.docx",
            "Privacy Policy.docx",
            "privacy-policy.docx",
        ],
    },
    "terms-and-conditions": {
        "slug": "terms-and-conditions",
        "title": "Terms & Conditions",
        "subtitle": "Terms of use, licensing, and responsibilities when using TSW6Ti.",
        "badge": "Service Terms",
        "icon": "fa-solid fa-file-contract",
        "filenames": [
            "TSW6Ti Terms and Conditions.docx",
            "TSW6Ti Terms & Conditions.docx",
            "TSW6Ti Terms of Service.docx",
            "Terms and Conditions.docx",
            "Terms & Conditions.docx",
            "Terms of Service.docx",
            "terms-and-conditions.docx",
        ],
    },
}

# Friendly URL slug aliases mapping to canonical document names
SLUG_ALIASES = {
    "terms-of-service": "terms-and-conditions",
    "terms": "terms-and-conditions",
    "privacy": "privacy-policy",
}

# Maps alias URL slugs like terms-of-service to canonical document identifiers
def normalizeDocSlug(slug):
    cleaned = str(slug or "").strip().lower()
    return SLUG_ALIASES.get(cleaned, cleaned)

# Safely extracts OpenXML namespaced attributes from an XML element
def _wAttr(el, name):
    return el.attrib.get(f"{{{W_NS}}}{name}")

# Generates unique URL fragment anchors from heading text
def _slugify(text, seenCounts):
    base = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "section"
    count = seenCounts.get(base, 0) + 1
    seenCounts[base] = count
    return base if count == 1 else f"{base}-{count}"

# Formats raw byte counts into human-readable B, KB or MB strings
def _formatSize(numBytes):
    if numBytes < 1024:
        return f"{numBytes} B"
    if numBytes < 1024 * 1024:
        return f"{numBytes / 1024:.1f} KB"
    return f"{numBytes / (1024 * 1024):.1f} MB"

# Formats ISO date timestamps into clean British English date strings
def _formatModifiedDate(isoStr, fallbackMtime):
    dt = None
    if isoStr:
        try:
            dt = datetime.fromisoformat(str(isoStr).replace("Z", "+00:00"))
        except ValueError:
            dt = None
    if dt is None and fallbackMtime is not None:
        dt = datetime.fromtimestamp(fallbackMtime, tz=timezone.utc)
    if dt is None:
        return ""
    return dt.strftime("%d %B %Y").lstrip("0")

# Parses word/numbering.xml to map list definitions to ordered or unordered list types
def _parseNumberingMap(zf):
    if "word/numbering.xml" not in zf.namelist():
        return {}
    numRoot = ET.fromstring(zf.read("word/numbering.xml"))
    abstractTypes = {}
    for absEl in numRoot.findall(f"{{{W_NS}}}abstractNum"):
        absId = _wAttr(absEl, "abstractNumId")
        lvl0 = absEl.find(f"{{{W_NS}}}lvl[@{{{W_NS}}}ilvl='0']")
        if lvl0 is None:
            lvl0 = absEl.find(f"{{{W_NS}}}lvl")
        numFmtEl = lvl0.find(f"{{{W_NS}}}numFmt") if lvl0 is not None else None
        numFmt = _wAttr(numFmtEl, "val") if numFmtEl is not None else "bullet"
        abstractTypes[absId] = "ol" if numFmt in ORDERED_FORMATS else "ul"

    numMap = {}
    for numEl in numRoot.findall(f"{{{W_NS}}}num"):
        numId = _wAttr(numEl, "numId")
        absRef = numEl.find(f"{{{W_NS}}}abstractNumId")
        absId = _wAttr(absRef, "val") if absRef is not None else None
        numMap[numId] = abstractTypes.get(absId, "ul")
    return numMap

# Extracts hyperlink targets and URLs from document relationship mappings
def _parseRelationships(zf):
    relPath = "word/_rels/document.xml.rels"
    if relPath not in zf.namelist():
        return {}
    rels = {}
    relRoot = ET.fromstring(zf.read(relPath))
    for rel in relRoot:
        rid = rel.attrib.get("Id")
        target = rel.attrib.get("Target", "")
        if rid and target and SAFE_LINK_RE.match(target):
            rels[rid] = target
    return rels

# Checks whether boolean text formatting flags like bold, italic or underline are active
def _isFlagEnabled(rPr, tag):
    el = rPr.find(f"{{{W_NS}}}{tag}")
    if el is None:
        return False
    val = (_wAttr(el, "val") or "true").lower()
    return val not in ("0", "false", "off", "none")

# Escapes plain text and turns recognised URLs and application routes into clickable links
def _autoLinkEscapedText(text):
    parts = []
    last = 0
    for m in AUTO_LINK_RE.finditer(text):
        start, end = m.span()
        if start > last:
            parts.append(html.escape(text[last:start]))
        rawUrl = m.group(0)
        trimmed = rawUrl.rstrip(".,;:)")
        trailing = rawUrl[len(trimmed):]
        escapedHref = html.escape(trimmed, quote=True)
        escapedLabel = html.escape(trimmed)
        if trimmed.startswith(("http://", "https://")):
            parts.append(
                f'<a href="{escapedHref}" target="_blank" rel="noopener noreferrer">{escapedLabel}</a>'
            )
        else:
            parts.append(f'<a href="{escapedHref}">{escapedLabel}</a>')
        if trailing:
            parts.append(html.escape(trailing))
        last = end
    if last < len(text):
        parts.append(html.escape(text[last:]))
    return "".join(parts)

# Renders an individual text run element into escaped inline HTML with formatting
def _renderRunHtml(runEl, linkify=True):
    pieces = []
    for child in runEl:
        local = child.tag.split("}")[-1]
        if local == "t":
            txt = child.text or ""
            pieces.append(_autoLinkEscapedText(txt) if linkify else html.escape(txt))
        elif local == "br":
            pieces.append("<br>")
        elif local == "tab":
            pieces.append(" &emsp; ")
    inner = "".join(pieces)
    if not inner:
        return ""

    rPr = runEl.find(f"{{{W_NS}}}rPr")
    if rPr is not None:
        if _isFlagEnabled(rPr, "u"):
            inner = f"<u>{inner}</u>"
        if _isFlagEnabled(rPr, "i"):
            inner = f"<em>{inner}</em>"
        if _isFlagEnabled(rPr, "b"):
            inner = f"<strong>{inner}</strong>"
    return inner

# Renders all runs and hyperlinks inside a paragraph element
def _renderParagraphInline(pEl, rels, linkify=True):
    chunks = []
    plainChunks = []
    for child in pEl:
        local = child.tag.split("}")[-1]
        if local == "r":
            rendered = _renderRunHtml(child, linkify=linkify)
            if rendered:
                chunks.append(rendered)
            plainChunks.append("".join(t.text or "" for t in child.findall(f"{{{W_NS}}}t")))
        elif local == "hyperlink":
            rid = child.attrib.get(f"{{{R_NS}}}id")
            anchor = _wAttr(child, "anchor")
            href = rels.get(rid) if rid else (f"#{anchor}" if anchor else None)
            inner = "".join(_renderRunHtml(r, linkify=False) for r in child.findall(f"{{{W_NS}}}r"))
            plainChunks.append("".join(t.text or "" for t in child.findall(f".//{{{W_NS}}}t")))
            if inner and href and (href.startswith("#") or SAFE_LINK_RE.match(href)):
                escHref = html.escape(href, quote=True)
                attrs = ' target="_blank" rel="noopener noreferrer"' if href.startswith(("http://", "https://")) else ""
                chunks.append(f'<a href="{escHref}"{attrs}>{inner}</a>')
            elif inner:
                chunks.append(inner)
    return "".join(chunks), "".join(plainChunks).strip()

# Converts document tables into responsive styled HTML tables
def _renderTableHtml(tblEl, rels):
    rows = tblEl.findall(f"{{{W_NS}}}tr")
    if not rows:
        return ""
    out = ['<div class="legal-table-wrap"><table class="legal-table">']
    for idx, tr in enumerate(rows):
        cells = tr.findall(f"{{{W_NS}}}tc")
        if not cells:
            continue
        isHeader = idx == 0 and len(rows) > 1
        tag = "th" if isHeader else "td"
        if idx == 0 and isHeader:
            out.append("<thead>")
        elif idx == 1 and len(rows) > 1:
            out.append("<tbody>")
        out.append("<tr>")
        for tc in cells:
            cellParas = []
            for p in tc.findall(f"{{{W_NS}}}p"):
                inlineHtml, plain = _renderParagraphInline(p, rels)
                if plain or inlineHtml:
                    cellParas.append(inlineHtml)
            out.append(f"<{tag}>" + "<br>".join(cellParas) + f"</{tag}>")
        out.append("</tr>")
        if idx == 0 and isHeader:
            out.append("</thead>")
    if len(rows) > 1:
        out.append("</tbody>")
    elif rows:
        pass
    out.append("</table></div>")
    return "".join(out)

# Parses a .docx file natively into HTML, table of contents sections and metadata
def parseDocxToHtml(docxPath):
    with zipfile.ZipFile(docxPath, "r") as zf:
        numMap = _parseNumberingMap(zf)
        rels = _parseRelationships(zf)
        docRoot = ET.fromstring(zf.read("word/document.xml"))

        modifiedIso = ""
        if "docProps/core.xml" in zf.namelist():
            coreRoot = ET.fromstring(zf.read("docProps/core.xml"))
            modEl = coreRoot.find(f"{{{DCTERMS_NS}}}modified")
            if modEl is not None and modEl.text:
                modifiedIso = modEl.text.strip()

    body = docRoot.find(f"{{{W_NS}}}body")
    if body is None:
        return {
            "docTitle": "",
            "doc_title": "",
            "html": Markup(""),
            "sections": [],
            "modifiedIso": modifiedIso,
            "modified_iso": modifiedIso,
        }

    htmlParts = []
    sections = []
    seenIds = {}
    activeListTag = None
    docTitle = ""

    def closeList():
        nonlocal activeListTag
        if activeListTag:
            htmlParts.append(f"</{activeListTag}>")
            activeListTag = None

    for child in body:
        local = child.tag.split("}")[-1]
        if local == "p":
            pPr = child.find(f"{{{W_NS}}}pPr")
            pStyleEl = pPr.find(f"{{{W_NS}}}pStyle") if pPr is not None else None
            pStyle = _wAttr(pStyleEl, "val") if pStyleEl is not None else ""
            numPr = pPr.find(f"{{{W_NS}}}numPr") if pPr is not None else None
            numIdEl = numPr.find(f"{{{W_NS}}}numId") if numPr is not None else None
            numId = _wAttr(numIdEl, "val") if numIdEl is not None else None
            ilvlEl = numPr.find(f"{{{W_NS}}}ilvl") if numPr is not None else None
            try:
                ilvl = max(0, int(_wAttr(ilvlEl, "val") or "0")) if numId is not None else 0
            except ValueError:
                ilvl = 0

            isHeading = pStyle in HEADING_STYLES
            inlineHtml, plainText = _renderParagraphInline(child, rels, linkify=not isHeading)
            if not plainText and not inlineHtml:
                continue

            if pStyle == "Title" and not docTitle:
                docTitle = plainText
                continue

            if pStyle == "Subtitle":
                closeList()
                htmlParts.append(f'<p class="legal-subtitle">{inlineHtml}</p>')
                continue

            if isHeading:
                closeList()
                level = HEADING_STYLES[pStyle]
                anchorId = _slugify(plainText, seenIds)
                if level == 2:
                    sections.append({"id": anchorId, "title": plainText})
                htmlParts.append(f'<h{level} id="{html.escape(anchorId, quote=True)}" class="legal-heading legal-h{level}">{inlineHtml}</h{level}>')
                continue

            if numId is not None or pStyle == "ListParagraph":
                listTag = numMap.get(numId, "ul")
                if activeListTag != listTag:
                    closeList()
                    htmlParts.append(f'<{listTag} class="legal-list">')
                    activeListTag = listTag
                indentCls = f' class="legal-li-nested-{min(ilvl, 3)}"' if ilvl > 0 else ""
                htmlParts.append(f"<li{indentCls}>{inlineHtml}</li>")
                continue

            closeList()
            if pStyle in ("Quote", "IntenseQuote"):
                htmlParts.append(f'<blockquote class="legal-quote">{inlineHtml}</blockquote>')
            else:
                htmlParts.append(f'<p class="legal-paragraph">{inlineHtml}</p>')

        elif local == "tbl":
            closeList()
            tblHtml = _renderTableHtml(child, rels)
            if tblHtml:
                htmlParts.append(tblHtml)

    closeList()
    return {
        "docTitle": docTitle,
        "doc_title": docTitle,
        "html": Markup("\n".join(htmlParts)),
        "sections": sections,
        "modifiedIso": modifiedIso,
        "modified_iso": modifiedIso,
    }

# Locates the matching .docx file on disk for a given document metadata configuration
def resolveLegalFilename(docMeta, legalDir):
    if not os.path.isdir(legalDir):
        return None
    for candidate in docMeta.get("filenames", []):
        path = os.path.join(legalDir, candidate)
        if os.path.isfile(path):
            return candidate
    return None

# Builds the complete template context for rendering a legal document page
def loadLegalDocument(slug, legalDir):
    canonical = normalizeDocSlug(slug)
    meta = LEGAL_DOCUMENTS.get(canonical)
    if meta is None:
        return None

    navDocs = []
    for itemSlug, itemMeta in LEGAL_DOCUMENTS.items():
        navDocs.append({
            "slug": itemSlug,
            "title": itemMeta["title"],
            "active": itemSlug == canonical,
            "available": resolveLegalFilename(itemMeta, legalDir) is not None,
        })

    filename = resolveLegalFilename(meta, legalDir)
    if filename is None:
        return {
            "slug": canonical,
            "title": meta["title"],
            "shortTitle": meta["title"],
            "short_title": meta["title"],
            "subtitle": meta["subtitle"],
            "badge": meta["badge"],
            "icon": meta["icon"],
            "available": False,
            "filename": None,
            "fileSize": "",
            "file_size": "",
            "lastUpdated": "",
            "last_updated": "",
            "sections": [],
            "bodyHtml": Markup(""),
            "body_html": Markup(""),
            "navDocs": navDocs,
            "nav_docs": navDocs,
        }

    absPath = os.path.join(legalDir, filename)
    stat = os.stat(absPath)
    parsed = parseDocxToHtml(absPath)
    displayTitle = parsed["docTitle"] or meta["title"]
    fileSizeFormatted = _formatSize(stat.st_size)
    lastUpdatedFormatted = _formatModifiedDate(parsed["modifiedIso"], stat.st_mtime)

    return {
        "slug": canonical,
        "title": displayTitle,
        "shortTitle": meta["title"],
        "short_title": meta["title"],
        "subtitle": meta["subtitle"],
        "badge": meta["badge"],
        "icon": meta["icon"],
        "available": True,
        "filename": filename,
        "fileSize": fileSizeFormatted,
        "file_size": fileSizeFormatted,
        "lastUpdated": lastUpdatedFormatted,
        "last_updated": lastUpdatedFormatted,
        "sections": parsed["sections"],
        "bodyHtml": parsed["html"],
        "body_html": parsed["html"],
        "navDocs": navDocs,
        "nav_docs": navDocs,
    }

# Backwards compatibility aliases
load_legal_document = loadLegalDocument
parse_docx_to_html = parseDocxToHtml
resolve_legal_filename = resolveLegalFilename
normalize_doc_slug = normalizeDocSlug
