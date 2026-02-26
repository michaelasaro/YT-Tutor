"""
VideoTutor Backend Server
=========================
Fetches YouTube transcripts given a video URL.

Setup:
    pip install flask youtube-transcript-api yt-dlp

Run:
    python server.py

Then open http://localhost:5000 in your browser.

No API key needed - this just serves the frontend and fetches transcripts.
You'll copy the prepared context into Claude yourself.
"""

import html
import re
import subprocess
import traceback
from flask import Flask, request, jsonify, send_from_directory

try:
    from youtube_transcript_api import YouTubeTranscriptApi
except ImportError:
    print("Missing: pip install youtube-transcript-api")
    exit(1)

app = Flask(__name__, static_folder=".", static_url_path="")


# ---- Serve the frontend ----

@app.route("/")
def index():
    return send_from_directory(".", "index.html")


# ---- Transcript endpoint ----

def extract_video_id(url: str) -> str | None:
    patterns = [
        r'(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})',
        r'^([a-zA-Z0-9_-]{11})$',
    ]
    for p in patterns:
        m = re.search(p, url)
        if m:
            return m.group(1)
    return None



def format_timestamp(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


@app.route("/api/transcript", methods=["POST"])
def get_transcript():
    data = request.json or {}
    url = data.get("url", "")
    video_id = extract_video_id(url)

    if not video_id:
        return jsonify({"error": "Could not extract video ID from URL"}), 400

    try:
        ytt_api = YouTubeTranscriptApi()

        # Detect transcript source type (manual vs auto-generated)
        # Priority: manual English > auto English > manual any > auto any
        transcript_type = "unknown"
        target_transcript = None
        try:
            transcript_list = ytt_api.list(video_id)
            candidates = []
            for t in transcript_list:
                lang = getattr(t, 'language_code', '') or ''
                is_en = lang.startswith('en')
                is_manual = not t.is_generated
                # Score: higher = better (English manual = 3, English auto = 2, other manual = 1, other auto = 0)
                score = (2 if is_en else 0) + (1 if is_manual else 0)
                candidates.append((score, is_manual, t))
            if candidates:
                candidates.sort(key=lambda x: x[0], reverse=True)
                best_score, best_manual, best = candidates[0]
                target_transcript = best
                transcript_type = "manual" if best_manual else "auto-generated"
        except Exception as e:
            print(f"Warning: Could not list transcripts: {e}")

        # Fetch transcript — use selected one or fall back to default fetch
        if target_transcript is not None:
            transcript = target_transcript.fetch()
        else:
            transcript = ytt_api.fetch(video_id)

        entries = []
        plain_lines = []
        for entry in transcript.snippets:
            ts = format_timestamp(entry.start)
            text = html.unescape(entry.text)
            entries.append({
                "time": entry.start,
                "timestamp": ts,
                "text": text,
            })
            plain_lines.append(f"[{ts}] {text}")

        # Get metadata from yt-dlp
        title = ""
        chapters = []
        metadata = {"transcript_type": transcript_type}
        try:
            import json
            result = subprocess.run(
                ['yt-dlp', '--dump-json', '--no-warnings', '--no-download',
                 f'https://www.youtube.com/watch?v={video_id}'],
                capture_output=True, text=True, timeout=20
            )
            if result.stdout:
                info = json.loads(result.stdout)
                title = info.get("title", "")

                raw_chapters = info.get("chapters", []) or []
                chapters = [
                    {
                        "title": ch.get("title", ""),
                        "start_time": ch.get("start_time", 0),
                        "end_time": ch.get("end_time", 0),
                        "timestamp": format_timestamp(ch.get("start_time", 0)),
                    }
                    for ch in raw_chapters
                ]

                metadata = {
                    "channel": info.get("channel", ""),
                    "channel_subscribers": info.get("channel_follower_count", 0),
                    "upload_date": info.get("upload_date", ""),
                    "duration": info.get("duration", 0),
                    "view_count": info.get("view_count", 0),
                    "like_count": info.get("like_count", 0),
                    "tags": info.get("tags", []),
                    "categories": info.get("categories", []),
                    "description": info.get("description", ""),
                    "playlist_title": info.get("playlist_title", ""),
                    "playlist_index": info.get("playlist_index", None),
                    "playlist_count": info.get("n_entries", None),
                    "transcript_type": transcript_type,
                    "heatmap": info.get("heatmap", []),
                }
        except Exception as e:
            print(f"Warning: Could not fetch metadata via yt-dlp: {e}")

        return jsonify({
            "video_id": video_id,
            "title": title,
            "entries": entries,
            "plain_text": "\n".join(plain_lines),
            "chapters": chapters,
            "metadata": metadata,
        })

    except Exception as e:
        traceback.print_exc()
        error_msg = str(e)
        # Extract a clean reason from youtube-transcript-api's verbose errors
        if "unplayable" in error_msg.lower():
            reason_match = re.search(r"for the following reason:\s*(.+?)(?:\n|If you are sure)", error_msg, re.DOTALL)
            if reason_match:
                error_msg = f"Video is not accessible: {reason_match.group(1).strip()}"
        elif "no transcripts" in error_msg.lower() or "could not retrieve" in error_msg.lower():
            error_msg = "No transcript available for this video."
        return jsonify({"error": error_msg}), 400


if __name__ == "__main__":
    print("\n  YT-Tutor running at http://localhost:5000\n")
    app.run(port=5000, debug=True)
