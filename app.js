/* ========================================
   VideoTutor - Context Builder
   ========================================
   
   Two-step workflow:
   1. Copy an initialization message (transcript + metadata)
      into a new Claude chat once.
   2. Copy lightweight questions (just the question + timestamp)
      as you watch and pause.
   
   Business logic is separated from DOM manipulation
   for easy migration to a framework later.
   
   ======================================== */


// ---- State ----

const state = {
    videoId: null,
    videoTitle: "",
    videoUrl: "",
    transcript: null,       // { entries: [...], plain_text: "..." }
    chapters: [],            // { title, start_time, end_time, timestamp }
    metadata: null,          // extended metadata from yt-dlp
    currentTime: 0,
    initScope: "timestamps", // "timestamps" | "plain"
    initSent: false,
    questionLog: [],         // { timestamp: "1:23", question: "...", askedAt: Date }
    theatreMode: false,
};

let ytPlayer = null;
let timeUpdateInterval = null;
let transcriptScrollPaused = false;
let transcriptScrollTimer = null;


// ========================================
// BUSINESS LOGIC
// ========================================

// ---- URL Parsing ----

function extractVideoId(url) {
    if (!url) return null;
    const patterns = [
        /(?:v=|\/v\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    return null;
}

function formatTimestamp(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDate(yt_dlp_date) {
    if (!yt_dlp_date) return "Unknown";
    const y = yt_dlp_date.substring(0, 4);
    const m = parseInt(yt_dlp_date.substring(4, 6)) - 1;
    const d = parseInt(yt_dlp_date.substring(6, 8));
    return new Date(y, m, d).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric'
    });
}

function formatCount(n) {
    if (!n) return "unknown";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
    return n.toString();
}

function formatDuration(seconds) {
    if (!seconds) return "unknown";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
}

function formatTranscriptType(type) {
    if (type === "manual") return "Creator-provided subtitles";
    if (type === "auto-generated")
        return "Auto-generated captions (may contain errors, especially in technical terminology)";
    return "Unknown source";
}


// ---- Transcript Fetching ----

async function fetchTranscript(videoUrl) {
    const resp = await fetch("/api/transcript", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: videoUrl }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Failed to fetch transcript");
    return data;
}


// ---- Context Building ----

function getRelatedThreads() {
    const inputs = document.querySelectorAll(".thread-input");
    const threads = [];
    inputs.forEach(input => {
        const val = input.value.trim();
        if (val) threads.push(val);
    });
    return threads;
}

function getTranscriptForScope(scope) {
    if (!state.transcript) return "[No transcript loaded]";

    switch (scope) {
        case "timestamps":
            return state.transcript.plain_text;

        case "plain":
            // Strip timestamps for smaller payload
            return state.transcript.entries
                .map(e => e.text)
                .join(" ");

        default:
            return state.transcript.plain_text;
    }
}

function buildInitMessage() {
    const threads = getRelatedThreads();
    const transcriptText = getTranscriptForScope(state.initScope);
    const meta = state.metadata || {};
    const opts = getInitOptions();

    let msg = `I'm watching a YouTube video and I'd like to discuss it with you as my learning companion. Here's the full context:\n\n`;

    // Video Information
    msg += `## Video Information\n`;
    msg += `- **Title:** ${state.videoTitle || "Untitled"}\n`;

    if (opts.metadata) {
        msg += `- **Channel:** ${meta.channel || "Unknown"}`;
        if (meta.channel_subscribers) msg += ` (${formatCount(meta.channel_subscribers)} subscribers)`;
        msg += `\n`;
        msg += `- **Published:** ${formatDate(meta.upload_date)}\n`;
        msg += `- **Duration:** ${formatDuration(meta.duration)}\n`;
        msg += `- **Views:** ${formatCount(meta.view_count)}\n`;
        msg += `- **Likes:** ${formatCount(meta.like_count)}\n`;
        if (meta.categories && meta.categories.length > 0) {
            msg += `- **Category:** ${meta.categories.join(", ")}\n`;
        }
        if (meta.tags && meta.tags.length > 0) {
            msg += `- **Tags:** ${meta.tags.join(", ")}\n`;
        }
    }

    msg += `- **URL:** https://www.youtube.com/watch?v=${state.videoId}\n`;

    // Series Context
    if (meta.playlist_title) {
        msg += `\n## Series Context\n`;
        msg += `This video is part ${meta.playlist_index || "?"} of ${meta.playlist_count || "?"} in the playlist "${meta.playlist_title}".\n`;
    }

    // Video Chapters
    if (state.chapters.length > 0) {
        msg += `\n## Video Chapters\n`;
        state.chapters.forEach(ch => {
            msg += `- [${ch.timestamp}] ${ch.title}\n`;
        });
    }

    // Description
    if (opts.description && meta.description) {
        msg += `\n## Video Description\n`;
        msg += `${meta.description}\n`;
    }

    // Related Threads
    if (threads.length > 0) {
        msg += `\n## My Related Conversations\n`;
        msg += `I've been exploring related ideas in other threads — reference these if relevant:\n`;
        threads.forEach(t => {
            msg += `- ${t}\n`;
        });
    }

    // Transcript
    msg += `\n## Transcript\n`;
    msg += `**Source:** ${formatTranscriptType(meta.transcript_type)}\n\n`;
    msg += `${transcriptText}\n\n`;

    // How I'd Like to Work Together
    msg += `---\n\n`;
    msg += `## How I'd Like to Work Together\n\n`;
    msg += `When you receive this message, please:\n`;

    if (opts.summary) {
        msg += `- Start with a brief summary of the video's main argument and key claims.\n`;
    }
    if (opts.chapterSummary && state.chapters.length > 0) {
        msg += `- Provide a chapter-by-chapter summary of the video's structure and progression.\n`;
    }

    msg += `- When I ask questions, I'll include my current position in the video.\n`;
    msg += `- Act as a tutor: help me understand, make connections to other ideas, and push my thinking rather than just answering questions.\n`;
    msg += `- Reference specific parts of the transcript when relevant, including timestamps.\n`;
    msg += `- If I'm confused about something, help me identify *what* I'm confused about before explaining.\n`;
    msg += `- If the speaker makes a claim, help me evaluate it — what's the evidence, what's contested, what's the speaker's particular perspective vs. consensus.\n`;
    msg += `- Use what you know about the speaker/channel to contextualize their claims, perspective, and potential biases.\n`;

    if (meta.playlist_title) {
        msg += `- This video is part of a series. Note when the speaker references earlier or later episodes, or when a topic seems like it's continued elsewhere in the series.\n`;
    }

    if (meta.transcript_type === "auto-generated") {
        msg += `- The transcript is auto-generated. Be cautious about quoting exact wording — technical terms, proper nouns, and specialized vocabulary may be transcribed incorrectly. If something looks off, flag it as a possible transcription error rather than attributing it to the speaker.\n`;
    }

    return msg;
}



// ---- Export ----

function buildExportMarkdown() {
    let md = `# Video Notes: ${state.videoTitle || "Untitled"}\n`;
    md += `**Source:** https://www.youtube.com/watch?v=${state.videoId}\n`;
    md += `**Date:** ${new Date().toLocaleDateString()}\n\n`;

    md += `---\n\n## Notes & Questions\n\n`;

    for (const entry of state.questionLog) {
        md += `**[${entry.timestamp}`;
        if (entry.chapter) md += ` | ${entry.chapter}`;
        md += `]**\n${entry.text}\n\n`;
    }

    return md;
}


// ========================================
// DOM / UI
// ========================================

function $(id) { return document.getElementById(id); }


// ---- YouTube Player ----

function onYouTubeIframeAPIReady() {
    // Player created when video is loaded
}

function createPlayer(videoId) {
    $("video-placeholder").style.display = "none";

    // If player already exists, just load the new video
    if (ytPlayer && ytPlayer.loadVideoById) {
        ytPlayer.cueVideoById(videoId);
        return;
    }

    ytPlayer = new YT.Player("video-player", {
        videoId: videoId,
        playerVars: {
            autoplay: 0,
            modestbranding: 1,
            rel: 0,
        },
        events: {
            onStateChange: onPlayerStateChange,
        },
    });

    if (timeUpdateInterval) clearInterval(timeUpdateInterval);
    timeUpdateInterval = setInterval(() => {
        if (ytPlayer && ytPlayer.getCurrentTime) {
            state.currentTime = ytPlayer.getCurrentTime();
            $("current-position").textContent = formatTimestamp(state.currentTime);
            highlightActiveTranscriptEntry();
            highlightActiveChapter();
        }
    }, 500);
}

function onPlayerStateChange(event) {
    // When user pauses (state 2), update timestamp
    if (event.data === 2) {
        state.currentTime = ytPlayer.getCurrentTime();
        $("current-position").textContent = formatTimestamp(state.currentTime);
    }
}


// ---- Transcript Display ----

function renderChapters(chapters) {
    state.chapters = chapters;
    const tab = $("chapters-tab");
    const divider = tab.previousElementSibling; // the "|" divider
    const list = $("chapters-list");

    const chapterOpt = $("opt-chapter-summary");
    if (!chapters || chapters.length === 0) {
        tab.style.display = "none";
        divider.style.display = "none";
        chapterOpt.checked = false;
        chapterOpt.disabled = true;
        chapterOpt.parentElement.classList.add("disabled");
        return;
    }

    chapterOpt.disabled = false;
    chapterOpt.parentElement.classList.remove("disabled");
    tab.style.display = "";
    divider.style.display = "";
    list.innerHTML = "";

    for (const ch of chapters) {
        const link = document.createElement("div");
        link.className = "chapter-link";
        link.dataset.start = ch.start_time;
        link.dataset.end = ch.end_time;

        const time = document.createElement("span");
        time.className = "chapter-time";
        time.textContent = ch.timestamp;
        link.appendChild(time);

        link.appendChild(document.createTextNode(ch.title));

        link.addEventListener("click", () => {
            if (ytPlayer && ytPlayer.seekTo) {
                ytPlayer.seekTo(ch.start_time, true);
            }
        });

        list.appendChild(link);
    }
}

function switchTab(tab) {
    const tabs = document.querySelectorAll(".panel-tab");
    tabs.forEach(t => {
        const isActive = t.dataset.tab === tab;
        t.classList.toggle("active", isActive);
        t.setAttribute("aria-selected", isActive);
    });

    const transcriptContent = $("transcript-content");
    const chaptersContent = $("chapters-content");
    const status = $("transcript-status");

    if (tab === "transcript") {
        transcriptContent.style.display = "";
        chaptersContent.style.display = "none";
        status.style.display = "";
    } else {
        transcriptContent.style.display = "none";
        chaptersContent.style.display = "";
        status.style.display = "none";
    }
}

function highlightActiveChapter() {
    const links = document.querySelectorAll(".chapter-link");
    let currentChapterName = "";
    for (const el of links) {
        const start = parseFloat(el.dataset.start);
        const end = parseFloat(el.dataset.end);
        const isActive = state.currentTime >= start && state.currentTime < end;
        el.classList.toggle("active", isActive);
        if (isActive) {
            // Extract chapter title (skip the timestamp span)
            currentChapterName = el.textContent.replace(el.querySelector(".chapter-time")?.textContent || "", "").trim();
        }
    }
    // Update context section chapter display
    $("current-chapter").textContent = currentChapterName;
    $("chapter-row").style.display = currentChapterName ? "" : "none";
}

function renderTranscript(data) {
    state.transcript = data;
    state.videoTitle = data.title || state.videoTitle;
    state.metadata = data.metadata || null;

    // Update title in context section
    $("current-title").textContent = state.videoTitle;
    $("title-row").style.display = state.videoTitle ? "" : "none";

    // Render chapters if present
    renderChapters(data.chapters || []);

    const container = $("transcript-entries");
    const paste = $("transcript-paste");
    const status = $("transcript-status");

    paste.style.display = "none";
    container.style.display = "block";
    container.innerHTML = "";

    status.textContent = `${data.entries.length} segments`;

    for (const entry of data.entries) {
        const div = document.createElement("div");
        div.className = "transcript-entry";
        div.dataset.time = entry.time;

        if (entry.timestamp) {
            const ts = document.createElement("span");
            ts.className = "transcript-timestamp";
            ts.textContent = entry.timestamp;
            div.appendChild(ts);
        }

        div.appendChild(document.createTextNode(entry.text));

        div.addEventListener("click", () => {
            if (ytPlayer && ytPlayer.seekTo) {
                ytPlayer.seekTo(entry.time, true);
            }
        });

        container.appendChild(div);
    }

    // Enable buttons
    $("copy-init-btn").disabled = false;

    // Update init preview if visible
    updateInitPreview();
}

function highlightActiveTranscriptEntry() {
    const entries = document.querySelectorAll(".transcript-entry");
    let activeEntry = null;

    for (const el of entries) {
        const time = parseFloat(el.dataset.time);
        el.classList.remove("active");
        if (time <= state.currentTime) {
            activeEntry = el;
        }
    }

    if (activeEntry) {
        activeEntry.classList.add("active");
        if (!transcriptScrollPaused) {
            const container = $("transcript-content");
            const entryTop = activeEntry.offsetTop;
            const containerScroll = container.scrollTop;
            const containerHeight = container.clientHeight;
            if (entryTop < containerScroll || entryTop > containerScroll + containerHeight - 40) {
                transcriptScrollPaused = "auto";
                activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
                setTimeout(() => {
                    if (transcriptScrollPaused === "auto") transcriptScrollPaused = false;
                }, 500);
            }
        }
    }
}

function showTranscriptError(message) {
    $("transcript-loading").style.display = "none";
    $("transcript-error").style.display = "block";
    $("transcript-error").textContent = message;
    $("transcript-paste").style.display = "block";
    $("transcript-paste").placeholder = `Automatic fetch failed: ${message}\n\nPaste the transcript here manually.`;
}


// ---- Related Threads ----

function addThreadInput() {
    const container = $("related-threads");
    const entry = document.createElement("div");
    entry.className = "thread-entry";
    entry.innerHTML = `
        <input type="text" class="thread-input" placeholder='e.g. "Quantum mechanics basics"'>
        <button class="btn-icon remove" onclick="removeThreadInput(this)" title="Remove">×</button>
    `;
    container.appendChild(entry);
    entry.querySelector("input").focus();
}

function removeThreadInput(btn) {
    btn.closest(".thread-entry").remove();
}


// ---- Init Options ----

function getInitOptions() {
    return {
        timestamps: $("opt-timestamps").checked,
        metadata: $("opt-metadata").checked,
        description: $("opt-description").checked,
        summary: $("opt-summary").checked,
        chapterSummary: $("opt-chapter-summary").checked,
    };
}

function saveInitOptions() {
    const opts = getInitOptions();
    localStorage.setItem("initOptions", JSON.stringify(opts));
    state.initScope = opts.timestamps ? "timestamps" : "plain";
    updateInitPreview();
}

function loadInitOptions() {
    const saved = localStorage.getItem("initOptions");
    if (saved) {
        try {
            const opts = JSON.parse(saved);
            if (opts.timestamps !== undefined) $("opt-timestamps").checked = opts.timestamps;
            if (opts.metadata !== undefined) $("opt-metadata").checked = opts.metadata;
            if (opts.description !== undefined) $("opt-description").checked = opts.description;
            if (opts.summary !== undefined) $("opt-summary").checked = opts.summary;
            if (opts.chapterSummary !== undefined) $("opt-chapter-summary").checked = opts.chapterSummary;
            state.initScope = opts.timestamps ? "timestamps" : "plain";
        } catch (e) {}
    }
}

function updateInitPreview() {
    const preview = $("init-preview");
    if (preview.style.display !== "none") {
        preview.textContent = buildInitMessage();
    }
}

function toggleInitPreview() {
    const preview = $("init-preview");
    const btn = preview.previousElementSibling?.querySelector("[aria-controls='init-preview']")
        || document.querySelector("[aria-controls='init-preview']");
    if (preview.style.display === "none") {
        preview.style.display = "block";
        preview.textContent = buildInitMessage();
        if (btn) btn.setAttribute("aria-expanded", "true");
    } else {
        preview.style.display = "none";
        if (btn) btn.setAttribute("aria-expanded", "false");
    }
}


// ---- Info Modal ----

function openInfoModal() {
    $("info-modal-overlay").style.display = "flex";
    document.addEventListener("keydown", infoModalKeyHandler);
}

function closeInfoModal() {
    $("info-modal-overlay").style.display = "none";
    document.removeEventListener("keydown", infoModalKeyHandler);
}

function infoModalKeyHandler(e) {
    if (e.key === "Escape") closeInfoModal();
}


// ---- Theatre Mode ----

function toggleTheatreMode() {
    state.theatreMode = !state.theatreMode;
    $("main").classList.toggle("theatre", state.theatreMode);
    $("theatre-btn").classList.toggle("active", state.theatreMode);
    $("theatre-btn").setAttribute("aria-pressed", state.theatreMode);
    localStorage.setItem("theatreMode", state.theatreMode);

    // Reset custom resize sizes when switching modes
    $("main").style.gridTemplateColumns = "";
    $("main").style.gridTemplateRows = "";
}


// ---- Collapsible Sections ----

function toggleSection(name) {
    const body = $(name + "-body");
    const icon = $(name + "-collapse-icon");
    const header = body.previousElementSibling;
    const isCollapsed = body.classList.contains("collapsed");

    if (isCollapsed) {
        body.classList.remove("collapsed");
        icon.classList.remove("collapsed");
    } else {
        body.classList.add("collapsed");
        icon.classList.add("collapsed");
    }

    // Sync aria-expanded on the header
    if (header && header.hasAttribute("aria-expanded")) {
        header.setAttribute("aria-expanded", isCollapsed ? "true" : "false");
    }

    // Persist collapse state
    const collapseStates = JSON.parse(localStorage.getItem("collapseStates") || "{}");
    collapseStates[name] = !isCollapsed;
    localStorage.setItem("collapseStates", JSON.stringify(collapseStates));
}

function restoreCollapseStates() {
    const saved = JSON.parse(localStorage.getItem("collapseStates") || "{}");
    for (const [name, collapsed] of Object.entries(saved)) {
        const body = $(name + "-body");
        const icon = $(name + "-collapse-icon");
        if (body && icon) {
            body.classList.toggle("collapsed", collapsed);
            icon.classList.toggle("collapsed", collapsed);
            const header = body.previousElementSibling;
            if (header && header.hasAttribute("aria-expanded")) {
                header.setAttribute("aria-expanded", !collapsed);
            }
        }
    }
}


// ---- Resize Handles ----

function initResize(handleEl, getTarget, dimension) {
    let startPos, startSize;

    function onMouseDown(e) {
        e.preventDefault();
        handleEl.classList.add("active");
        const target = getTarget();
        if (!target) return;

        if (dimension === "height") {
            startPos = e.clientY;
            startSize = target.getBoundingClientRect().height;
        } else {
            startPos = e.clientX;
            startSize = target.getBoundingClientRect().width;
        }

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        document.body.style.cursor = dimension === "height" ? "ns-resize" : "ew-resize";
        document.body.style.userSelect = "none";
        // Prevent iframe from swallowing mouse events during drag
        document.querySelectorAll("iframe").forEach(f => f.style.pointerEvents = "none");
    }

    function onMouseMove(e) {
        const target = getTarget();
        if (!target) return;
        const delta = (dimension === "height" ? e.clientY : e.clientX) - startPos;
        const mainEl = $("main");
        const isMobile = window.innerWidth <= 768;
        const refSize = dimension === "height"
            ? (isMobile ? window.innerHeight - mainEl.getBoundingClientRect().top : mainEl.clientHeight)
            : mainEl.clientWidth;
        const maxSize = refSize - 150;
        const newSize = Math.min(maxSize, Math.max(100, startSize + delta));

        if (dimension === "height") {
            // In mobile flex layout, set height directly; in grid layout, update row template
            if (window.innerWidth <= 768) {
                getTarget().style.height = newSize + "px";
            } else {
                $("main").style.gridTemplateRows = newSize + "px 4px 1fr";
            }
        } else {
            // Update grid columns — works for both default and theatre mode
            $("main").style.gridTemplateColumns = newSize + "px 4px 1fr";
        }
    }

    function onMouseUp() {
        handleEl.classList.remove("active");
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        document.querySelectorAll("iframe").forEach(f => f.style.pointerEvents = "");
    }

    handleEl.addEventListener("mousedown", onMouseDown);
}

// Horizontal handle: resize video area height
initResize(
    $("resize-video"),
    () => $("video-area"),
    "height"
);

// Vertical handle: resize the left column (steps panel) width
initResize(
    $("resize-panels"),
    () => $("steps-panel"),
    "width"
);

// Clear inline resize styles when crossing the mobile/desktop breakpoint
let wasMobile = window.innerWidth <= 768;
window.addEventListener("resize", () => {
    const isMobile = window.innerWidth <= 768;
    if (isMobile !== wasMobile) {
        $("video-area").style.height = "";
        $("main").style.gridTemplateRows = "";
        $("main").style.gridTemplateColumns = "";
        $("steps-panel").style.width = "";
        wasMobile = isMobile;
    }
});


// ---- Clipboard ----

async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        // Fallback for non-HTTPS contexts
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand("copy");
            document.body.removeChild(ta);
            return true;
        } catch (e) {
            document.body.removeChild(ta);
            return false;
        }
    }
}

function showCopyNotice(elementId, duration = 5000, fade = 1000) {
    const el = $(elementId);
    el.style.display = "inline";
    el.style.opacity = "1";
    el.style.transition = "none";
    // Force reflow so the transition reset takes effect
    void el.offsetWidth;
    el.style.transition = `opacity ${fade}ms ease`;
    setTimeout(() => { el.style.opacity = "0"; }, duration);
}


// ---- Notebook ----

function getCurrentChapterName() {
    if (state.chapters.length === 0) return "";
    const ch = state.chapters.find(
        c => state.currentTime >= c.start_time && state.currentTime < c.end_time
    );
    return ch ? ch.title : "";
}

function addNote() {
    const input = $("notebook-input");
    const text = input.value.trim();
    if (!text) return;

    const ts = formatTimestamp(state.currentTime);
    const chapter = getCurrentChapterName();

    state.questionLog.push({
        timestamp: ts,
        chapter: chapter,
        text: text,
        askedAt: new Date(),
    });

    input.value = "";
    renderNotebookLog();
    updateNotebookBadge();
    enableLogButtons();
}

async function copyLogEntry(index) {
    const entry = state.questionLog[index];
    if (!entry) return;
    let text = `[${entry.timestamp}`;
    if (entry.chapter) text += ` | ${entry.chapter}`;
    text += `]\n${entry.text}`;
    await copyToClipboard(text);
}

function deleteLogEntry(index) {
    state.questionLog.splice(index, 1);
    renderNotebookLog();
    updateNotebookBadge();
    if (state.questionLog.length === 0) {
        $("copy-log-btn").disabled = true;
        $("copy-log-btn").className = "btn-small";
        $("export-log-btn").disabled = true;
        $("export-log-btn").className = "btn-small";
    }
}

function renderNotebookLog() {
    const log = $("notebook-log");

    if (state.questionLog.length === 0) {
        log.innerHTML = '<div id="log-empty" class="log-placeholder">Notes and questions will appear here with timestamps.</div>';
        return;
    }

    log.innerHTML = "";
    state.questionLog.forEach((entry, i) => {
        const div = document.createElement("div");
        div.className = "log-entry";

        let headerText = `[${entry.timestamp}`;
        if (entry.chapter) headerText += ` | ${entry.chapter}`;
        headerText += `]`;

        div.innerHTML = `
            <div class="log-header">
                <span class="log-timestamp">${escapeHtml(headerText)}</span>
                <div class="log-actions">
                    <button class="btn-icon log-action-btn" onclick="copyLogEntry(${i})" title="Copy note" aria-label="Copy note at ${escapeHtml(entry.timestamp)}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <rect x="9" y="9" width="13" height="13" rx="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                    </button>
                    <button class="btn-icon log-action-btn" onclick="deleteLogEntry(${i})" title="Delete note" aria-label="Delete note at ${escapeHtml(entry.timestamp)}">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="log-text">${escapeHtml(entry.text)}</div>
        `;
        log.appendChild(div);
    });
    log.scrollTop = log.scrollHeight;
}

function updateNotebookBadge() {
    const badge = $("notebook-count");
    if (state.questionLog.length > 0) {
        badge.textContent = `(${state.questionLog.length})`;
        badge.style.display = "inline";
    } else {
        badge.style.display = "none";
    }
}

function enableLogButtons() {
    $("copy-log-btn").disabled = false;
    $("copy-log-btn").className = "btn-small active";
    $("export-log-btn").disabled = false;
    $("export-log-btn").className = "btn-small active";
}

async function copyFullLog() {
    if (state.questionLog.length === 0) return;

    let msg = `I watched "${state.videoTitle || "Untitled"}" and took these notes/questions as I watched.\nPlease help me work through them:\n\n`;

    for (const entry of state.questionLog) {
        msg += `[${entry.timestamp}`;
        if (entry.chapter) msg += ` | ${entry.chapter}`;
        msg += `]\n${entry.text}\n\n`;
    }

    const ok = await copyToClipboard(msg.trim());
    if (ok) {
        showCopyNotice("context-copy-notice");
    }
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}


// ========================================
// ACTIONS
// ========================================

async function loadVideo() {
    const url = $("video-url-input").value.trim();
    const videoId = extractVideoId(url);

    if (!videoId) {
        alert("Could not find a YouTube video ID in that URL.");
        return;
    }

    // Reset state
    state.videoId = videoId;
    state.videoUrl = url;
    state.transcript = null;
    state.chapters = [];
    state.metadata = null;
    state.currentTime = 0;
    state.videoTitle = "";
    state.initSent = false;
    state.questionLog = [];

    // Reset UI
    $("current-position").textContent = "0:00";
    $("current-title").textContent = "";
    $("title-row").style.display = "none";
    $("current-chapter").textContent = "";
    $("chapter-row").style.display = "none";
    $("init-status").style.display = "none";
    $("copy-init-btn").disabled = true;
    $("init-preview").style.display = "none";
    // Expand init section for new video
    $("init-body").classList.remove("collapsed");
    $("init-collapse-icon").classList.remove("collapsed");
    // Reset notebook
    $("notebook-input").value = "";
    $("notebook-log").innerHTML = '<div id="log-empty" class="log-placeholder">Notes and questions will appear here with timestamps.</div>';
    $("copy-log-btn").disabled = true;
    $("copy-log-btn").className = "btn-small";
    $("export-log-btn").disabled = true;
    $("export-log-btn").className = "btn-small";
    $("notebook-count").style.display = "none";
    // Reset tabs to transcript view and hide chapters tab
    switchTab("transcript");
    $("chapters-tab").style.display = "none";
    $("chapters-tab").previousElementSibling.style.display = "none";

    // Load player
    createPlayer(videoId);

    // Fetch transcript
    $("transcript-loading").style.display = "block";
    $("transcript-error").style.display = "none";
    $("transcript-entries").style.display = "none";
    $("transcript-entries").innerHTML = "";
    $("transcript-paste").style.display = "none";
    $("transcript-status").textContent = "loading...";

    try {
        const data = await fetchTranscript(url);
        $("transcript-loading").style.display = "none";
        renderTranscript(data);
    } catch (err) {
        $("transcript-loading").style.display = "none";
        showTranscriptError(err.message);
        $("transcript-status").textContent = "manual mode";
    }
}

async function copyInitMessage() {
    // Check for manual transcript paste
    if (!state.transcript) {
        const paste = $("transcript-paste");
        if (paste.value.trim()) {
            state.transcript = {
                entries: [],
                plain_text: paste.value.trim(),
            };
        } else {
            return;
        }
    }

    const msg = buildInitMessage();
    const ok = await copyToClipboard(msg);

    if (ok) {
        state.initSent = true;
        showCopyNotice("init-status");
        // Auto-collapse since it's no longer needed
        toggleSection('init');
    }
}

async function copyContext() {
    const ts = formatTimestamp(state.currentTime);
    const chapter = getCurrentChapterName();

    let msg = `[Timestamp: ${ts}. Video title: "${state.videoTitle || "Untitled"}"`;
    if (chapter) msg += `. Chapter: "${chapter}"`;
    msg += `.]`;

    const ok = await copyToClipboard(msg);
    if (ok) {
        showCopyNotice("context-copy-notice");
    }
}

function exportLog() {
    if (state.questionLog.length === 0) return;

    const md = buildExportMarkdown();
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `video-questions-${state.videoId || "export"}.md`;
    a.click();
    URL.revokeObjectURL(url);
}


// ========================================
// EVENT LISTENERS
// ========================================

$("video-url-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadVideo();
});

// Notebook: Enter key adds note (Shift+Enter for newline)
$("notebook-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        addNote();
    }
});

// Pause transcript auto-scroll on user scroll, resume 3s after last scroll
$("transcript-content").addEventListener("scroll", () => {
    if (transcriptScrollPaused === "auto") return; // ignore programmatic scrolls
    transcriptScrollPaused = true;
    if (transcriptScrollTimer) clearTimeout(transcriptScrollTimer);
    transcriptScrollTimer = setTimeout(() => {
        transcriptScrollPaused = false;
        transcriptScrollTimer = null;
    }, 3000);
});

// Theatre mode keyboard shortcut
document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (e.key === "t" || e.key === "T") toggleTheatreMode();
});

// Restore theatre mode preference
if (localStorage.getItem("theatreMode") === "true") {
    toggleTheatreMode();
}

// Restore init options from localStorage
loadInitOptions();

// Restore collapse states from localStorage
restoreCollapseStates();

// Handle manual transcript paste
$("transcript-paste").addEventListener("input", () => {
    const text = $("transcript-paste").value.trim();
    if (text) {
        state.transcript = {
            entries: [],
            plain_text: text,
        };
        $("copy-init-btn").disabled = false;
    }
});
