// NH LawViz front-end
// Loads data/laws-index.json (titles → chapters → section stubs) and
// data/issues.json, then renders the connections arc chart, the by-title
// bar chart, an RSA search with full-text drill-in, and the issue list.

const CATEGORY_ORDER = ["contradiction", "ambiguity", "outdated", "discrimination", "other"];
const CATEGORY_LABEL = {
    contradiction: "Contradictions",
    ambiguity: "Ambiguities",
    outdated: "Outdated refs",
    discrimination: "Discriminatory",
    other: "Other",
};

let STATE = {
    laws: null,
    issues: [],
    activeCategory: "all",
    sectionIdx: null,
    activeArcCats: new Set(["contradiction", "ambiguity", "outdated", "discrimination"]),
    pinnedIssue: null,
    zoomLevel: "all",   // "all" | "title" | "chapter"
    zoomTitle: null,    // title id when zoomed in
    zoomChapter: null,  // chapter id when zoomed in
};

async function loadJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
}

// Per-title full-text shard cache (fetched lazily for RSA detail view)
const SHARD_CACHE = new Map();
async function getTitleShard(titleId) {
    if (SHARD_CACHE.has(titleId)) return SHARD_CACHE.get(titleId);
    const t = await loadJSON(`data/laws-text/${titleId}.json`);
    SHARD_CACHE.set(titleId, t);
    return t;
}

// True when a section heading or chapter name is just a repeal marker
// (e.g. "Repealed by 1985, 399:24, I, eff. July 1, 1985" or
// "Chapter 570 Repealed" or "to 3:7-c Repealed by 1977..."). Used to
// dim the corresponding ticks/labels in the arc chart.
function isRepealedHeading(s) {
    return /\brepealed\b/i.test(s || "");
}
function isRepealedChapter(c) {
    if (isRepealedHeading(c.name)) return true;
    return c.sections.length > 0 && c.sections.every(s => isRepealedHeading(s.heading));
}

function sectionIndex(laws) {
    if (STATE.sectionIdx) return STATE.sectionIdx;
    const idx = new Map();
    for (const t of laws.titles) {
        for (const c of t.chapters) {
            for (const s of c.sections) {
                idx.set(s.id, { title: t.id, chapter: c.id, section: s });
            }
        }
    }
    STATE.sectionIdx = idx;
    return idx;
}

// Build a "view" for the current zoom level.
// Returns { units, groups, arcs, dots, zoomable, emptyMessage }
// where units are the ticks to draw, groups are optional bands above ticks,
// arcs/dots are issue connectors, zoomable indicates if ticks respond to clicks.
function buildArcView(laws, issues) {
    const idx = sectionIndex(laws);

    function refLocs(iss) {
        return (iss.refs || [])
            .map(r => idx.get(r))
            .filter(Boolean);
    }

    if (STATE.zoomLevel === "all") {
        // Units = titles. Drop the "Title " prefix when there are many titles
        // so the rotated labels stay tight; keep the full label in the tooltip.
        const dense = laws.titles.length > 20;
        const units = laws.titles.map((t, i) => ({
            i,
            key: t.id,
            label: dense ? t.id : `Title ${t.id}`,
            sublabel: t.name,
            tooltip: `Title ${t.id} — ${t.name}\n${t.chapters.length} chapters`,
            zoomTarget: { level: "title", title: t.id },
        }));
        const keyIdx = new Map(units.map(u => [u.key, u.i]));

        const { arcs, dots } = arcsDotsFrom(issues, iss => {
            const ks = Array.from(new Set(refLocs(iss).map(l => l.title)));
            return ks.map(k => keyIdx.get(k)).filter(v => v !== undefined);
        });

        // Count refs per unit for "referenced" styling
        for (const iss of issues) {
            const seen = new Set();
            for (const loc of refLocs(iss)) {
                if (!seen.has(loc.title)) {
                    seen.add(loc.title);
                    const i = keyIdx.get(loc.title);
                    if (i !== undefined) units[i].refCount = (units[i].refCount || 0) + 1;
                }
            }
        }

        return { units, groups: [], arcs, dots, zoomable: true };
    }

    if (STATE.zoomLevel === "title") {
        const t = laws.titles.find(t => t.id === STATE.zoomTitle);
        if (!t) return { units: [], groups: [], arcs: [], dots: [], zoomable: false };

        const units = t.chapters.map((c, i) => {
            const repealed = isRepealedChapter(c);
            return {
                i,
                key: `${t.id}/${c.id}`,
                label: (repealed ? "✕ " : "") + c.id,
                sublabel: c.name,
                tooltip: `${t.id} Chapter ${c.id}${c.name ? ": " + c.name : ""}${repealed ? " (repealed)" : ""}\n${c.sections.length} sections`,
                zoomTarget: { level: "chapter", title: t.id, chapter: c.id },
                repealed,
            };
        });
        const keyIdx = new Map(units.map(u => [u.key, u.i]));

        const { arcs, dots } = arcsDotsFrom(issues, iss => {
            const ks = Array.from(new Set(
                refLocs(iss).filter(l => l.title === t.id).map(l => `${l.title}/${l.chapter}`)
            ));
            return ks.map(k => keyIdx.get(k)).filter(v => v !== undefined);
        });

        for (const iss of issues) {
            const seen = new Set();
            for (const loc of refLocs(iss)) {
                if (loc.title !== t.id) continue;
                const k = `${loc.title}/${loc.chapter}`;
                if (!seen.has(k)) {
                    seen.add(k);
                    const i = keyIdx.get(k);
                    if (i !== undefined) units[i].refCount = (units[i].refCount || 0) + 1;
                }
            }
        }

        return {
            units,
            groups: [{ label: `Title ${t.id}`, sublabel: t.name, start: 0, end: units.length - 1 }],
            arcs, dots, zoomable: true,
        };
    }

    if (STATE.zoomLevel === "chapter") {
        const t = laws.titles.find(t => t.id === STATE.zoomTitle);
        const c = t && t.chapters.find(c => c.id === STATE.zoomChapter);
        if (!c) return { units: [], groups: [], arcs: [], dots: [], zoomable: false };

        const units = c.sections.map((s, i) => {
            const repealed = isRepealedHeading(s.heading);
            const numericLabel = s.id.split(":").slice(-1)[0];
            return {
                i,
                key: s.id,
                label: (repealed ? "✕ " : "") + numericLabel,
                sublabel: s.heading,
                tooltip: `${s.id} ${s.heading}`,
                link: s.url,
                repealed,
            };
        });
        const keyIdx = new Map(units.map(u => [u.key, u.i]));

        const { arcs, dots } = arcsDotsFrom(issues, iss => {
            const ks = Array.from(new Set(
                refLocs(iss).filter(l => l.title === t.id && l.chapter === c.id).map(l => l.section.id)
            ));
            return ks.map(k => keyIdx.get(k)).filter(v => v !== undefined);
        });

        for (const iss of issues) {
            for (const loc of refLocs(iss)) {
                if (loc.title !== t.id || loc.chapter !== c.id) continue;
                const i = keyIdx.get(loc.section.id);
                if (i !== undefined) units[i].refCount = (units[i].refCount || 0) + 1;
            }
        }

        return {
            units,
            groups: [{ label: `${t.id} Chapter ${c.id}`, sublabel: c.name, start: 0, end: units.length - 1 }],
            arcs, dots, zoomable: false,
        };
    }

    return { units: [], groups: [], arcs: [], dots: [], zoomable: false };
}

function arcsDotsFrom(issues, unitIndicesForIssue) {
    const arcs = [];
    const dots = [];
    for (const iss of issues) {
        const idxs = unitIndicesForIssue(iss).sort((a, b) => a - b);
        if (idxs.length === 0) continue;
        const totalRefs = (iss.refs || []).length;
        if (idxs.length === 1) {
            // True single-ref issue → dot. A multi-ref issue whose refs all
            // collapse to one unit at this zoom level → small self-loop so
            // the visual grammar stays consistent (dots = atomic, arcs = links).
            if (totalRefs <= 1) {
                dots.push({ issue: iss, pos: idxs[0] });
            } else {
                arcs.push({ issue: iss, a: idxs[0], b: idxs[0], isLoop: true });
            }
        } else {
            for (let a = 0; a < idxs.length; a++) {
                for (let b = a + 1; b < idxs.length; b++) {
                    arcs.push({ issue: iss, a: idxs[a], b: idxs[b] });
                }
            }
        }
    }
    return { arcs, dots };
}

function renderBreadcrumb(laws, previewLabel = null) {
    const nav = document.getElementById("arc-breadcrumb");
    nav.innerHTML = "";

    const crumbs = [{ label: "All Titles", target: { level: "all" } }];
    if (STATE.zoomLevel === "title" || STATE.zoomLevel === "chapter") {
        const tName = (laws.titles.find(t => t.id === STATE.zoomTitle) || {}).name || "";
        crumbs.push({
            label: `Title ${STATE.zoomTitle}${tName ? " · " + tName : ""}`,
            target: { level: "title", title: STATE.zoomTitle },
        });
    }
    if (STATE.zoomLevel === "chapter") {
        const t = laws.titles.find(t => t.id === STATE.zoomTitle);
        const c = t && t.chapters.find(c => c.id === STATE.zoomChapter);
        crumbs.push({ label: `Chapter ${STATE.zoomChapter}${c && c.name ? " · " + c.name : ""}`, target: null });
    }

    crumbs.forEach((crumb, i) => {
        if (i > 0) {
            const sep = document.createElement("span");
            sep.className = "separator";
            sep.textContent = "›";
            nav.appendChild(sep);
        }
        const isLast = i === crumbs.length - 1 && !previewLabel;
        if (isLast) {
            const span = document.createElement("span");
            span.className = "current";
            span.textContent = crumb.label;
            nav.appendChild(span);
        } else {
            const a = document.createElement("a");
            a.textContent = crumb.label;
            a.onclick = () => zoomTo(crumb.target);
            nav.appendChild(a);
        }
    });

    if (previewLabel) {
        const sep = document.createElement("span");
        sep.className = "separator";
        sep.textContent = "›";
        nav.appendChild(sep);
        const span = document.createElement("span");
        span.className = "preview";
        span.textContent = previewLabel;
        nav.appendChild(span);
    }
}

// What the breadcrumb should preview when hovering a tick/label at the
// current zoom level — describes the unit the user would zoom into (or, at
// the chapter level, the section the user would open).
function previewCrumbForUnit(d) {
    const tail = d.sublabel ? " · " + d.sublabel : "";
    if (STATE.zoomLevel === "all")     return `Title ${d.key}${tail}`;
    if (STATE.zoomLevel === "title")   return `Chapter ${d.label}${tail}`;
    if (STATE.zoomLevel === "chapter") return `RSA ${d.key}${tail}`;
    return d.label;
}

function zoomTo(target) {
    STATE.zoomLevel = target.level;
    STATE.zoomTitle = target.title || null;
    STATE.zoomChapter = target.chapter || null;
    STATE.pinnedIssue = null;
    renderArcChart(STATE.laws, STATE.issues);
    showArcHint();
}

// ---- Search ---------------------------------------------------------------

let SEARCH_ENTRIES = [];      // [{id, heading, title, chapter, chapterName, url, label}]
let SEARCH_ACTIVE = -1;       // keyboard-navigation cursor

function buildSearchEntries(laws) {
    SEARCH_ENTRIES = [];
    for (const t of laws.titles) {
        for (const c of t.chapters) {
            for (const s of c.sections) {
                SEARCH_ENTRIES.push({
                    id: s.id,
                    heading: s.heading || "",
                    title: t.id,
                    titleName: t.name,
                    chapter: c.id,
                    chapterName: c.name,
                    url: s.url,
                });
            }
        }
    }
}

function searchRSAs(query, limit = 20) {
    const q = query.trim().toLowerCase();
    if (q.length < 1) return [];
    const hits = [];
    for (const e of SEARCH_ENTRIES) {
        const idLower = e.id.toLowerCase();
        const headingLower = e.heading.toLowerCase();
        let score = 0;
        if (idLower === q) score = 1000;
        else if (idLower.startsWith(q)) score = 800;
        else if (idLower.includes(q)) score = 500;
        else if (headingLower.startsWith(q)) score = 300;
        else if (headingLower.includes(q)) score = 100;
        if (score > 0) hits.push({ entry: e, score });
        if (hits.length >= 500) break;
    }
    hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
    return hits.slice(0, limit).map(h => h.entry);
}

function renderSuggestions(entries) {
    const ul = document.getElementById("rsa-suggestions");
    ul.innerHTML = "";
    if (!entries.length) { ul.hidden = true; return; }
    entries.forEach((e, i) => {
        const li = document.createElement("li");
        li.className = "suggestion" + (i === SEARCH_ACTIVE ? " active" : "");
        li.dataset.index = i;

        const idEl = document.createElement("span");
        idEl.className = "suggestion-id";
        idEl.textContent = e.id;
        const headEl = document.createElement("span");
        headEl.className = "suggestion-heading";
        headEl.textContent = e.heading;
        const metaEl = document.createElement("span");
        metaEl.className = "suggestion-meta";
        metaEl.textContent = `${e.title} · ${e.chapterName || "Ch. " + e.chapter}`;

        li.append(idEl, headEl, metaEl);
        li.onmousedown = (ev) => { ev.preventDefault(); selectEntry(e); };
        ul.appendChild(li);
    });
    ul.hidden = false;
}

async function selectEntry(entry) {
    document.getElementById("rsa-search").value = entry.id;
    document.getElementById("rsa-suggestions").hidden = true;
    SEARCH_ACTIVE = -1;

    const section = document.getElementById("search");
    section.hidden = false;
    const detail = document.getElementById("rsa-detail");
    detail.innerHTML = '<p class="hint">Loading…</p>';

    try {
        const shard = await getTitleShard(entry.title);
        const chap = shard.chapters.find(c => c.id === entry.chapter);
        const sec = chap && chap.sections.find(s => s.id === entry.id);
        renderRSADetail(shard, chap, sec);
        section.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
        detail.innerHTML = `<p style="color:var(--accent)">Failed to load RSA text: ${err.message}</p>`;
    }
}

function renderRSADetail(titleObj, chap, sec) {
    const detail = document.getElementById("rsa-detail");
    detail.innerHTML = "";
    if (!sec) {
        detail.innerHTML = '<p class="hint">Section not found in shard.</p>';
        return;
    }

    const card = document.createElement("div");
    card.className = "rsa-card";

    const h = document.createElement("h3");
    h.textContent = `RSA ${sec.id}${sec.heading ? " — " + sec.heading : ""}`;
    card.appendChild(h);

    const crumb = document.createElement("div");
    crumb.className = "rsa-breadcrumb";
    crumb.textContent = `Title ${titleObj.id} · ${titleObj.name} › Chapter ${chap.id}${chap.name ? ": " + chap.name : ""}`;
    card.appendChild(crumb);

    if (sec.text) {
        const t = document.createElement("div");
        t.className = "rsa-text";
        t.textContent = sec.text;
        card.appendChild(t);
    } else {
        const t = document.createElement("p");
        t.className = "hint";
        t.textContent = "No text on file (the section may be repealed or merged).";
        card.appendChild(t);
    }

    if (sec.source) {
        const s = document.createElement("p");
        s.className = "rsa-source";
        s.innerHTML = `<b>Source.</b> ${sec.source}`;
        card.appendChild(s);
    }

    if (sec.url) {
        const a = document.createElement("a");
        a.className = "rsa-link";
        a.href = sec.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "View on gc.nh.gov ↗";
        card.appendChild(a);
    }

    detail.appendChild(card);

    // Issues referencing this section
    const related = STATE.issues.filter(iss => (iss.refs || []).includes(sec.id));
    const h2 = document.createElement("h3");
    h2.className = "rsa-issues-header";
    h2.textContent = `Issues referencing ${sec.id} — ${related.length}`;
    detail.appendChild(h2);

    if (!related.length) {
        const p = document.createElement("p");
        p.className = "rsa-issues-empty";
        p.textContent = "No curated issues currently reference this RSA.";
        detail.appendChild(p);
    } else {
        for (const iss of related) detail.appendChild(issueCard(iss));
    }
}

function bindSearch() {
    const input = document.getElementById("rsa-search");
    const ul = document.getElementById("rsa-suggestions");

    const update = () => {
        const q = input.value.trim();
        if (!q) {
            SEARCH_ACTIVE = -1;
            ul.hidden = true;
            document.getElementById("rsa-detail").innerHTML = "";
            return;
        }
        const entries = searchRSAs(q, 20);
        SEARCH_ACTIVE = entries.length ? 0 : -1;
        renderSuggestions(entries);
    };

    input.addEventListener("input", update);
    input.addEventListener("focus", () => { if (input.value.trim()) update(); });
    input.addEventListener("blur", () => {
        // Close after a tick so mousedown on suggestion can still fire
        setTimeout(() => { ul.hidden = true; }, 120);
    });
    input.addEventListener("keydown", (ev) => {
        if (ul.hidden) return;
        const items = ul.querySelectorAll(".suggestion");
        if (ev.key === "ArrowDown") {
            ev.preventDefault();
            SEARCH_ACTIVE = Math.min(items.length - 1, SEARCH_ACTIVE + 1);
            items.forEach((el, i) => el.classList.toggle("active", i === SEARCH_ACTIVE));
            items[SEARCH_ACTIVE] && items[SEARCH_ACTIVE].scrollIntoView({ block: "nearest" });
        } else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            SEARCH_ACTIVE = Math.max(0, SEARCH_ACTIVE - 1);
            items.forEach((el, i) => el.classList.toggle("active", i === SEARCH_ACTIVE));
            items[SEARCH_ACTIVE] && items[SEARCH_ACTIVE].scrollIntoView({ block: "nearest" });
        } else if (ev.key === "Enter" && SEARCH_ACTIVE >= 0) {
            ev.preventDefault();
            const entries = searchRSAs(input.value, 20);
            if (entries[SEARCH_ACTIVE]) selectEntry(entries[SEARCH_ACTIVE]);
        } else if (ev.key === "Escape") {
            ul.hidden = true;
        }
    });
}

// ---------------------------------------------------------------------------

function niceTitleCase(s) {
    return s.toLowerCase()
        .replace(/\b[a-z]/g, ch => ch.toUpperCase())
        .replace(/\b(And|Of|In|The|To|For|With|On)\b/g, w => w.toLowerCase());
}

function renderArcChart(laws, issues) {
    renderBreadcrumb(laws);
    const view = buildArcView(laws, issues);

    const container = d3.select("#arc-chart");
    container.selectAll("*").remove();

    if (!view.units.length) {
        container.append("p").attr("class", "hint").style("padding", "1rem").text("No data at this zoom level.");
        return;
    }

    // Fit width to the container.
    const containerWidth = container.node().clientWidth || 1000;
    const hasGroups = view.groups && view.groups.length > 0;
    const margin = { top: hasGroups ? 190 : 170, right: 20, bottom: 60, left: 20 };
    const innerWidth = Math.max(600, containerWidth - margin.left - margin.right);
    const tickGap = view.units.length <= 1 ? innerWidth / 2 : innerWidth / (view.units.length - 1);

    const height = margin.top + margin.bottom;
    const svg = container.append("svg")
        .attr("width", innerWidth + margin.left + margin.right)
        .attr("height", height);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
    const x = (i) => view.units.length === 1 ? innerWidth / 2 : i * tickGap;
    const approxWidth = (text, pxPerChar) => text.length * pxPerChar;

    // Optional grouping band at top — single line "Title XX · Name"
    if (hasGroups) {
        const bandY = -150;
        const band = g.selectAll(".title-band").data(view.groups).enter().append("g").attr("class", "title-band");
        band.append("line")
            .attr("class", "title-band-line")
            .attr("x1", d => x(d.start) - tickGap * 0.3)
            .attr("x2", d => x(d.end) + tickGap * 0.3)
            .attr("y1", bandY).attr("y2", bandY);
        band.append("text")
            .attr("class", "title-band-code")
            .attr("x", d => (x(d.start) + x(d.end)) / 2)
            .attr("y", bandY - 8)
            .attr("text-anchor", "middle")
            .text(d => {
                const nice = d.sublabel ? niceTitleCase(d.sublabel) : "";
                const combined = nice ? `${d.label} · ${nice}` : d.label;
                const spanPx = x(d.end) - x(d.start) + tickGap;
                return approxWidth(combined, 6.5) <= spanPx - 4 ? combined : d.label;
            })
            .append("title")
            .text(d => d.sublabel ? `${d.label} · ${d.sublabel}` : d.label);
    }

    // Helper to sync hover state between tick and label sharing the same unit
    // key, and to preview the unit's full name in the breadcrumb.
    function linkHover(selection) {
        selection
            .on("mouseenter", function (event, d) {
                g.selectAll(`[data-unit="${d.key}"]`).classed("hovered", true);
                renderBreadcrumb(STATE.laws, previewCrumbForUnit(d));
            })
            .on("mouseleave", function (event, d) {
                g.selectAll(`[data-unit="${d.key}"]`).classed("hovered", false);
                renderBreadcrumb(STATE.laws);
            });
    }

    // Ticks
    const tickGroup = g.selectAll(".arc-tick-group")
        .data(view.units)
        .enter()
        .append("g")
        .attr("class", d => "arc-tick-group"
            + (view.zoomable ? " zoomable" : "")
            + (d.repealed ? " repealed" : ""))
        .attr("data-unit", d => d.key)
        .attr("transform", d => `translate(${x(d.i)}, 0)`)
        .on("click", (event, d) => {
            if (view.zoomable && d.zoomTarget) zoomTo(d.zoomTarget);
            else if (d.link) window.open(d.link, "_blank", "noopener");
        })
        .call(linkHover);


    // Invisible wide hit area so ticks are easy to click
    const hitWidth = Math.min(18, Math.max(6, tickGap * 0.8));
    tickGroup.append("rect")
        .attr("class", "arc-tick-hit")
        .attr("x", -hitWidth / 2)
        .attr("y", -10)
        .attr("width", hitWidth)
        .attr("height", 24)
        .attr("fill", "transparent");

    tickGroup.append("line")
        .attr("class", d => "arc-tick"
            + (d.refCount ? " referenced" : "")
            + (view.zoomable ? " zoomable" : ""))
        .attr("x1", 0).attr("x2", 0)
        .attr("y1", d => d.refCount ? -6 : 0)
        .attr("y2", 8)
        .append("title")
        .text(d => d.tooltip || d.label);

    // Tick labels — adapt rotation/font to density so all labels remain visible.
    const dense = view.units.length > 20;
    const labelRotation = dense ? -60 : -35;
    const labelFontPx = dense ? 10 : 12;
    const charPx = dense ? 5.8 : 7.2;
    const labelGroup = g.selectAll(".chapter-label-group")
        .data(view.units)
        .enter()
        .append("g")
        .attr("class", d => "chapter-label-group link-label"
            + (view.zoomable ? " zoomable" : "")
            + (d.repealed ? " repealed" : ""))
        .attr("data-unit", d => d.key)
        .attr("transform", d => `translate(${x(d.i)}, 14) rotate(${labelRotation})`)
        .on("click", (event, d) => {
            event.stopPropagation();
            if (view.zoomable && d.zoomTarget) zoomTo(d.zoomTarget);
            else if (d.link) window.open(d.link, "_blank", "noopener");
        })
        .call(linkHover);

    // Background hit-rect — covers the rotated label footprint
    labelGroup.append("rect")
        .attr("class", "chapter-label-hit")
        .attr("x", d => -(d.label.length * charPx + 4))
        .attr("y", -labelFontPx)
        .attr("width", d => d.label.length * charPx + 4)
        .attr("height", labelFontPx + 4)
        .attr("fill", "transparent");

    labelGroup.append("text")
        .attr("class", "chapter-label")
        .attr("text-anchor", "end")
        .style("font-size", labelFontPx + "px")
        .text(d => d.label)
        .append("title")
        .text(d => d.tooltip || d.label);

    // Arcs + dots
    const maxArcHeight = 150;
    const nonLoopArcs = view.arcs.filter(d => !d.isLoop);
    const maxSpan = d3.max(nonLoopArcs, d => Math.abs(d.b - d.a)) || 1;

    // Stack self-loops vertically when multiple multi-ref issues collapse to the same unit
    const loopStack = new Map();
    for (const d of view.arcs) {
        if (!d.isLoop) continue;
        const n = loopStack.get(d.a) || 0;
        d.loopIndex = n;
        loopStack.set(d.a, n + 1);
    }

    const arcPath = (d) => {
        if (d.isLoop) {
            const cx = x(d.a);
            const r = 8;
            const baseY = -10 - (d.loopIndex || 0) * 14;
            // Small self-loop: half-circle above the tick
            return `M ${cx - r} ${baseY} Q ${cx} ${baseY - 2 * r} ${cx + r} ${baseY}`;
        }
        const x1 = x(d.a), x2 = x(d.b);
        const cx = (x1 + x2) / 2;
        const span = Math.abs(d.b - d.a);
        const h = Math.max(22, (span / maxSpan) * maxArcHeight);
        return `M ${x1} 0 Q ${cx} ${-h} ${x2} 0`;
    };

    g.selectAll(".issue-arc")
        .data(view.arcs)
        .enter()
        .append("path")
        .attr("class", d => `issue-arc cat-${d.issue.category}` + (d.isLoop ? " is-loop" : ""))
        .attr("data-issue", d => d.issue.id)
        .attr("data-cat", d => d.issue.category)
        .attr("d", arcPath)
        .on("mouseenter", (event, d) => { if (!STATE.pinnedIssue) renderArcDetail(d.issue); })
        .on("mouseleave", () => { if (!STATE.pinnedIssue) showArcHint(); })
        .on("click", (event, d) => { event.stopPropagation(); pinIssue(d.issue); })
        .append("title")
        .text(d => `${d.issue.title} [${d.issue.category}]\n${d.issue.refs.join(", ")}`);

    // Stack dots vertically when multiple issues sit at the same tick
    const dotStack = new Map();
    const stackedDots = view.dots.map(d => {
        const n = dotStack.get(d.pos) || 0;
        dotStack.set(d.pos, n + 1);
        return { ...d, stackIndex: n };
    });

    g.selectAll(".issue-dot")
        .data(stackedDots)
        .enter()
        .append("circle")
        .attr("class", d => `issue-dot cat-${d.issue.category}`)
        .attr("data-issue", d => d.issue.id)
        .attr("data-cat", d => d.issue.category)
        .attr("cx", d => x(d.pos))
        .attr("cy", d => -12 - d.stackIndex * 13)
        .attr("r", 5)
        .on("mouseenter", (event, d) => { if (!STATE.pinnedIssue) renderArcDetail(d.issue); })
        .on("mouseleave", () => { if (!STATE.pinnedIssue) showArcHint(); })
        .on("click", (event, d) => { event.stopPropagation(); pinIssue(d.issue); })
        .append("title")
        .text(d => `${d.issue.title} [${d.issue.category}] — ${d.issue.refs.join(", ")}`);

    applyArcFilters();
}

function applyArcFilters() {
    const active = STATE.activeArcCats;
    d3.selectAll(".issue-arc, .issue-dot").classed("dimmed", function () {
        return !active.has(this.getAttribute("data-cat"));
    });
    if (STATE.pinnedIssue) {
        d3.selectAll(".issue-arc, .issue-dot").classed("pinned", function () {
            return this.getAttribute("data-issue") === STATE.pinnedIssue;
        });
    } else {
        d3.selectAll(".issue-arc, .issue-dot").classed("pinned", false);
    }
}

function pinIssue(iss) {
    STATE.pinnedIssue = STATE.pinnedIssue === iss.id ? null : iss.id;
    renderArcDetail(STATE.pinnedIssue ? iss : null);
    applyArcFilters();
}

function showArcHint() {
    const panel = document.getElementById("arc-detail");
    panel.innerHTML = '<p class="hint">Hover an arc to preview; click to pin the issue here.</p>';
}

function renderArcDetail(iss) {
    const panel = document.getElementById("arc-detail");
    panel.innerHTML = "";
    if (!iss) { showArcHint(); return; }
    panel.appendChild(issueCard(iss));
    if (STATE.pinnedIssue === iss.id) {
        const hint = document.createElement("p");
        hint.className = "hint";
        hint.textContent = "Pinned — click the same arc again to unpin.";
        panel.appendChild(hint);
    }
}

function bindArcControls() {
    document.querySelectorAll(".arc-cat").forEach(box => {
        box.addEventListener("change", () => {
            if (box.checked) STATE.activeArcCats.add(box.value);
            else STATE.activeArcCats.delete(box.value);
            applyArcFilters();
        });
    });
}

function issuesByTitle(laws, issues) {
    const idx = sectionIndex(laws);
    const counts = new Map();
    for (const t of laws.titles) counts.set(t.id, { title: t.id, name: t.name, total: 0 });
    for (const iss of issues) {
        const seen = new Set();
        for (const r of iss.refs || []) {
            const loc = idx.get(r);
            if (!loc) continue;
            if (!seen.has(loc.title)) {
                seen.add(loc.title);
                counts.get(loc.title).total += 1;
            }
        }
    }
    return [...counts.values()];
}

function renderTitleBarChart(laws, issues) {
    const data = issuesByTitle(laws, issues);
    data.sort((a, b) => d3.descending(a.total, b.total) || d3.ascending(a.title, b.title));

    const container = d3.select("#title-chart");
    container.selectAll("*").remove();

    const containerWidth = container.node().clientWidth || 1000;
    const dense = data.length > 20;
    const labelRotation = dense ? -60 : -35;
    const labelFontPx = dense ? 10 : 12;
    const charPx = dense ? 5.8 : 7.2;
    const labelText = (d) => dense ? d.title : `Title ${d.title}`;
    const margin = { top: 20, right: 20, bottom: dense ? 90 : 70, left: 40 };
    const width = containerWidth - margin.left - margin.right;
    const height = 260;

    const svg = container.append("svg")
        .attr("width", containerWidth)
        .attr("height", height + margin.top + margin.bottom);
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const maxVal = d3.max(data, d => d.total) || 1;
    const x = d3.scaleBand().domain(data.map(d => d.title)).range([0, width]).padding(0.2);
    const y = d3.scaleLinear().domain([0, maxVal]).nice().range([height, 0]);

    // Hover link helper — highlights all elements with the same data-unit
    const linkHover = (sel) => sel
        .on("mouseenter", function (event, d) {
            const key = d.title || d.key;
            g.selectAll(`[data-unit="${key}"]`).classed("hovered", true);
        })
        .on("mouseleave", function (event, d) {
            const key = d.title || d.key;
            g.selectAll(`[data-unit="${key}"]`).classed("hovered", false);
        });

    // Y axis
    g.append("g")
        .attr("class", "axis")
        .call(d3.axisLeft(y).ticks(Math.min(maxVal, 6)).tickFormat(d3.format("d")));

    // X axis baseline + tick marks (but no default text — we'll render our own)
    g.append("g")
        .attr("class", "axis")
        .attr("transform", `translate(0, ${height})`)
        .call(d3.axisBottom(x).tickFormat(() => ""));

    // Custom x-axis labels — same density adaptation as the arc chart.
    const xLabels = g.selectAll(".chapter-label-group")
        .data(data)
        .enter()
        .append("g")
        .attr("class", "chapter-label-group link-label")
        .attr("data-unit", d => d.title)
        .attr("transform", d => `translate(${x(d.title) + x.bandwidth() / 2}, ${height + 14}) rotate(${labelRotation})`)
        .on("click", (event, d) => {
            zoomTo({ level: "title", title: d.title });
            document.getElementById("connections").scrollIntoView({ behavior: "smooth" });
        })
        .call(linkHover);

    xLabels.append("rect")
        .attr("class", "chapter-label-hit")
        .attr("x", d => -(labelText(d).length * charPx + 4))
        .attr("y", -labelFontPx)
        .attr("width", d => labelText(d).length * charPx + 4)
        .attr("height", labelFontPx + 4)
        .attr("fill", "transparent");

    xLabels.append("text")
        .attr("class", "chapter-label")
        .attr("text-anchor", "end")
        .style("font-size", labelFontPx + "px")
        .text(labelText)
        .append("title")
        .text(d => `Title ${d.title} — ${d.name}`);

    // Bars
    g.selectAll(".bar")
        .data(data)
        .enter()
        .append("rect")
        .attr("class", "bar")
        .attr("data-unit", d => d.title)
        .attr("x", d => x(d.title))
        .attr("y", d => y(d.total))
        .attr("width", x.bandwidth())
        .attr("height", d => height - y(d.total))
        .on("click", (event, d) => {
            zoomTo({ level: "title", title: d.title });
            document.getElementById("connections").scrollIntoView({ behavior: "smooth" });
        })
        .call(linkHover)
        .append("title")
        .text(d => `Title ${d.title} — ${d.name}\n${d.total} issue${d.total === 1 ? "" : "s"}`);

    // Value labels on top of each bar
    g.selectAll(".bar-value")
        .data(data)
        .enter()
        .append("text")
        .attr("class", "bar-value")
        .attr("x", d => x(d.title) + x.bandwidth() / 2)
        .attr("y", d => y(d.total) - 4)
        .attr("text-anchor", "middle")
        .text(d => d.total || "");
}

function renderStats(laws, issues) {
    const tc = laws.titles.length;
    const cc = laws.titles.reduce((n, t) => n + t.chapters.length, 0);
    const sc = laws.titles.reduce((n, t) => n + t.chapters.reduce((m, c) => m + c.sections.length, 0), 0);
    document.getElementById("stat-titles").textContent = tc;
    document.getElementById("stat-chapters").textContent = cc;
    document.getElementById("stat-sections").textContent = sc;
    document.getElementById("stat-issues").textContent = issues.length;
    for (const cat of CATEGORY_ORDER) {
        const el = document.getElementById(`stat-cat-${cat}`);
        if (el) el.textContent = issues.filter(i => i.category === cat).length;
    }

    // Wire the primary stat cards to the issue-list filter + scroll
    const filterAndScroll = (cat) => {
        STATE.activeCategory = cat;
        renderFilters(STATE.issues);
        renderIssueList();
        document.getElementById("issues").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    const totalCard = document.querySelector(".stat-total");
    if (totalCard) {
        totalCard.classList.add("clickable");
        totalCard.onclick = () => filterAndScroll("all");
    }
    for (const cat of CATEGORY_ORDER) {
        const card = document.querySelector(`.stat-cat.cat-${cat}`);
        if (card) {
            card.classList.add("clickable");
            card.onclick = () => filterAndScroll(cat);
        }
    }
}

function issueCard(iss) {
    const card = document.createElement("div");
    card.className = `issue-card cat-${iss.category}`;

    const header = document.createElement("div");
    header.className = "issue-header";
    const title = document.createElement("span");
    title.className = "issue-title";
    title.textContent = iss.title;
    const cat = document.createElement("span");
    cat.className = `issue-cat cat-${iss.category}`;
    cat.textContent = iss.category;
    header.append(title, cat);
    card.appendChild(header);

    const desc = document.createElement("p");
    desc.textContent = iss.description;
    card.appendChild(desc);

    if (iss.quote) {
        const q = document.createElement("blockquote");
        q.className = "issue-quote";
        q.textContent = "\u201c" + iss.quote + "\u201d";
        card.appendChild(q);
    }

    if (iss.refs && iss.refs.length) {
        const refs = document.createElement("p");
        refs.className = "issue-refs";
        refs.appendChild(document.createTextNode("Refs: "));
        const idx = sectionIndex(STATE.laws);
        iss.refs.forEach((r, i) => {
            if (i > 0) refs.appendChild(document.createTextNode(", "));
            const loc = idx.get(r);
            if (loc) {
                const a = document.createElement("a");
                a.href = loc.section.url;
                a.target = "_blank";
                a.rel = "noopener";
                a.textContent = r;
                refs.appendChild(a);
            } else {
                refs.appendChild(document.createTextNode(r));
            }
        });
        card.appendChild(refs);
    }

    return card;
}

function renderFilters(issues) {
    const wrap = document.getElementById("category-filters");
    wrap.innerHTML = "";

    const counts = { all: issues.length };
    for (const c of CATEGORY_ORDER) counts[c] = issues.filter(i => i.category === c).length;

    const mkBtn = (key, label) => {
        const b = document.createElement("button");
        b.className = "filter-btn" + (STATE.activeCategory === key ? " active" : "");
        b.textContent = `${label} (${counts[key] || 0})`;
        b.onclick = () => {
            STATE.activeCategory = key;
            renderFilters(issues);
            renderIssueList();
        };
        return b;
    };

    wrap.appendChild(mkBtn("all", "All"));
    for (const c of CATEGORY_ORDER) {
        if (counts[c]) wrap.appendChild(mkBtn(c, CATEGORY_LABEL[c] || c));
    }
}

function renderIssueList() {
    const list = document.getElementById("issue-list");
    list.innerHTML = "";
    const filtered = STATE.activeCategory === "all"
        ? STATE.issues
        : STATE.issues.filter(i => i.category === STATE.activeCategory);

    if (!filtered.length) {
        list.innerHTML = '<p class="hint">No issues in this category yet.</p>';
        return;
    }
    for (const iss of filtered) list.appendChild(issueCard(iss));
}

async function main() {
    try {
        const [laws, issues] = await Promise.all([
            loadJSON("data/laws-index.json"),
            loadJSON("data/issues.json"),
        ]);
        STATE.laws = laws;
        STATE.issues = issues.issues || issues;

        const steps = [
            ["renderStats",        () => renderStats(laws, STATE.issues)],
            ["buildSearchEntries", () => buildSearchEntries(laws)],
            ["bindSearch",         () => bindSearch()],
            ["renderArcChart",     () => renderArcChart(laws, STATE.issues)],
            ["bindArcControls",    () => bindArcControls()],
            ["renderTitleBarChart",() => renderTitleBarChart(laws, STATE.issues)],
            ["renderFilters",      () => renderFilters(STATE.issues)],
            ["renderIssueList",    () => renderIssueList()],
        ];
        for (const [name, fn] of steps) {
            try { fn(); } catch (err) {
                console.error(`[${name}] failed:`, err);
                document.querySelector("main").insertAdjacentHTML(
                    "afterbegin",
                    `<p style="color:var(--accent)">Step "${name}" crashed: ${err.message}. See console.</p>`
                );
            }
        }
    } catch (e) {
        console.error(e);
        document.querySelector("main").insertAdjacentHTML(
            "afterbegin",
            `<p style="color:var(--accent)">Failed to load data: ${e.message}. Make sure you're serving the site via a local HTTP server, and that data/laws.json and data/issues.json exist.</p>`
        );
    }
}

main();
