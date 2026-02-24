# YT-Tutor

Watch YouTube videos side-by-side with your AI tutor. Auto-fetches transcripts, chapters, and metadata so your AI has full context for deeper discussions.

This tool assembles the right context for you to paste into Claude (or any AI). No API key needed — you use your existing Claude subscription.

## How it works

**Initialize Chat:** Load a video, and the app fetches the transcript automatically.
Copy the initialization message (video info + full transcript + metadata) into a new Claude chat. You do this once per video.

**Current Context:** As you watch and discuss the video, copy your current timestamp and chapter to keep the AI oriented.

**Notebook:** Jot down notes and questions as you watch. Each entry is automatically tagged with the timestamp and chapter. Export your full log when done.

## Setup

You need Python 3.10+ installed. Then:

```bash
pip install flask youtube-transcript-api yt-dlp
```

No API key needed.

## Run

```bash
python server.py
```

Then open http://localhost:5000 in your browser.

## File structure

```
yt-tutor/
├── server.py     ← Python backend (transcript fetching + metadata)
├── index.html    ← App shell
├── style.css     ← Styles
├── app.js        ← Application logic
└── README.md     ← This file
```
