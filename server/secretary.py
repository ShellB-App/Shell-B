"""Shell:B Secretary Mode — live meeting listening, speaker identification, and executive summaries.

Captures spoken conversations in real time (or from uploaded audio recordings), identifies distinct speakers
via acoustic pitch and timbre profiling, produces diarized transcripts, and compiles structured executive
summaries with key decisions, action items, and discussion points via ShellB-Swift.
Summaries can be saved directly to the Codex reference shelf and action items exported to project todos.
"""
import asyncio
import io
import json
import logging
import math
import re
import time
import uuid
from pathlib import Path
from typing import Optional

import httpx
import numpy as np
import soundfile as sf
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

import db
import codex

router = APIRouter(prefix="/api/secretary")
log = logging.getLogger("shellb.secretary")

HERMES = "http://localhost:8001"
OLLAMA = "http://localhost:11434"
SPEAKER_DIST_THRESHOLD = 1.25
SENSITIVITY_THRESHOLDS = {
    "strict": 0.95,
    "high": 0.95,
    "balanced": 1.25,
    "normal": 1.25,
    "relaxed": 1.65,
    "low": 1.65,
}

SPEAKER_PALETTE = [
    "#38bdf8",  # Sky
    "#fb7185",  # Rose
    "#34d399",  # Emerald
    "#f59e0b",  # Amber
    "#a78bfa",  # Violet
    "#f472b6",  # Pink
    "#2dd4bf",  # Teal
    "#fbbf24",  # Yellow
    "#818cf8",  # Indigo
    "#4ade80",  # Green
]

# meeting_id -> { speaker_id -> list of feature vectors }
_SPEAKER_VECTORS: dict[str, dict[str, list[np.ndarray]]] = {}

# ── neural voice prints (HERMES /speaker_embed, WeSpeaker ResNet34) ──────────
# Cosine *distance* (1 - similarity) between a clip and a speaker's centroid. Measured on this box: the same voice in
# two speaking styles is ~0.29 apart; different voices 0.49-0.96 (similar women's voices are the close ones).
NEURAL = "wespeaker-r34-lm"
COSINE_THRESHOLDS = {"strict": 0.40, "high": 0.40, "balanced": 0.50, "normal": 0.50, "relaxed": 0.62, "low": 0.62}
NEW_SPEAKER_MIN_SECONDS = 1.5   # a shorter clip joins the nearest speaker rather than inventing a new one
MERGE_MAX_SECONDS, MERGE_MAX_UTTS = 4.0, 2  # clusters this small are folded into their nearest neighbour
RECLUSTER_EVERY = 25            # live meetings re-cluster everything this often
AUDIO = db.DATA / "secretary"   # each utterance's audio (and uploads), so voices can be re-identified later
_NEURAL: dict[str, dict[str, np.ndarray]] = {}   # meeting -> utterance id -> embedding
_hermes_down_until = 0.0


def _vec_init():
    with db.conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS meeting_vectors(meeting_id TEXT, utt_id TEXT, model TEXT, vec BLOB, "
                  "PRIMARY KEY(meeting_id, utt_id, model))")
        cols = {r["name"] for r in c.execute("PRAGMA table_info(meetings)")}
        if "diarizer" not in cols:
            c.execute("ALTER TABLE meetings ADD COLUMN diarizer TEXT DEFAULT 'legacy-17d'")


def _vec_put(mid: str, uid: str, vec: np.ndarray):
    with db.conn() as c:
        c.execute("INSERT OR REPLACE INTO meeting_vectors VALUES(?,?,?,?)",
                  (mid, uid, NEURAL, np.asarray(vec, dtype=np.float32).tobytes()))
    _NEURAL.setdefault(mid, {})[uid] = np.asarray(vec, dtype=np.float32)


def _vecs(mid: str) -> dict[str, np.ndarray]:
    if mid not in _NEURAL:
        with db.conn() as c:
            rows = c.execute("SELECT utt_id, vec FROM meeting_vectors WHERE meeting_id=? AND model=?", (mid, NEURAL)).fetchall()
        _NEURAL[mid] = {r["utt_id"]: np.frombuffer(r["vec"], dtype=np.float32) for r in rows}
    return _NEURAL[mid]


def _set_diarizer(mid: str, name: str):
    with db.conn() as c:
        c.execute("UPDATE meetings SET diarizer=? WHERE id=?", (name, mid))


async def _embed(audio: bytes, filename: str, segments: list | None = None) -> list | None:
    """Voice prints from HERMES: one per segment (or one for the clip). None when HERMES can't (then the old pitch/MFCC
    features are used); after a failure it isn't asked again for a minute."""
    global _hermes_down_until
    if time.time() < _hermes_down_until:
        return None
    try:
        data = {"segments": json.dumps(segments)} if segments else None
        async with httpx.AsyncClient(timeout=20 if not segments else 300) as c:
            r = await c.post(f"{HERMES}/speaker_embed", files={"file": (filename, audio)}, data=data)
        r.raise_for_status()
        return [np.asarray(e, dtype=np.float32) if e else None for e in r.json()["embeddings"]]
    except Exception as e:  # noqa: BLE001
        log.info("speaker_embed unavailable (%s); using basic voice features", e)
        _hermes_down_until = time.time() + 60
        return None


def _cosine_cluster(vecs: list[np.ndarray], durs: list[float], threshold: float, k: int | None = None) -> list[list[int]]:
    """Average-linkage agglomerative clustering on cosine distance (vectors are unit length), then small clusters are
    folded into the nearest bigger one. `k` forces exactly that many clusters."""
    n = len(vecs)
    if n == 0:
        return []
    X = np.stack(vecs)
    D = 1.0 - X @ X.T
    np.fill_diagonal(D, np.inf)
    clusters = {i: [i] for i in range(n)}
    while len(clusters) > 1:
        keys = list(clusters)
        sub = D[np.ix_(keys, keys)]
        a, b = np.unravel_index(np.argmin(sub), sub.shape)
        d = sub[a, b]
        if k is None and d > threshold or k is not None and len(clusters) <= k:
            break
        i, j = keys[a], keys[b]
        ni, nj = len(clusters[i]), len(clusters[j])
        D[i, :] = D[:, i] = (D[i, :] * ni + D[j, :] * nj) / (ni + nj)  # average linkage (Lance-Williams)
        D[i, i] = np.inf
        D[j, :] = D[:, j] = np.inf
        clusters[i] += clusters.pop(j)
    out = list(clusters.values())
    if k is None and len(out) > 1:
        big = [c for c in out if sum(durs[x] for x in c) > MERGE_MAX_SECONDS or len(c) > MERGE_MAX_UTTS]
        small = [c for c in out if c not in big]
        if big:
            cents = [X[c].mean(axis=0) for c in big]
            for c in small:
                v = X[c].mean(axis=0)
                big[int(np.argmax([v @ ct for ct in cents]))] += c
            out = big
    return [sorted(c) for c in out]


def _apply_clusters(m: dict, clusters: list[list[str]], keep_unclustered_to: dict | None = None):
    """Give utterances (by id) their new speakers, keeping names and colours: each new cluster takes the old speaker
    id it overlaps most, so a speaker renamed "Brad" stays Brad."""
    old = {s["id"]: s for s in m.get("speakers", [])}
    by_utt = {u["id"]: u for u in m.get("utterances", [])}
    clusters = sorted(clusters, key=lambda c: min(by_utt[u]["start"] for u in c))
    used, new = set(), []
    for c in clusters:
        votes: dict[str, float] = {}
        for uid in c:
            sid = by_utt[uid].get("speakerId")
            votes[sid] = votes.get(sid, 0) + (by_utt[uid]["end"] - by_utt[uid]["start"])
        pick = next((sid for sid, _ in sorted(votes.items(), key=lambda kv: -kv[1]) if sid in old and sid not in used), None)
        if pick:
            spk = {**old[pick]}
        else:
            n = 1
            while f"spk_{n}" in used or f"spk_{n}" in old:
                n += 1
            spk = {"id": f"spk_{n}", "name": f"Speaker {n}", "color": SPEAKER_PALETTE[(n - 1) % len(SPEAKER_PALETTE)]}
        used.add(spk["id"])
        pitches = [by_utt[u]["pitch"] for u in c if by_utt[u].get("pitch")]
        spk.update(utteranceCount=len(c), totalDuration=round(sum(by_utt[u]["end"] - by_utt[u]["start"] for u in c), 1),
                   pitch=round(float(np.mean(pitches)), 1) if pitches else spk.get("pitch", 150.0))
        for uid in c:
            by_utt[uid]["speakerId"], by_utt[uid]["speakerName"] = spk["id"], spk["name"]
        new.append(spk)
    if new:  # utterances without a voice print go with the speaker just before them
        last = new[0]
        ids = {s["id"]: s for s in new}
        for u in m["utterances"]:
            if u["speakerId"] in ids and any(u["id"] in c for c in clusters):
                last = ids[u["speakerId"]]
            elif not any(u["id"] in c for c in clusters):
                u["speakerId"], u["speakerName"] = last["id"], last["name"]
    m["speakers"] = new


def _neural_recluster(m: dict, threshold: float, k: int | None = None) -> bool:
    """Re-cluster a meeting on its voice prints. False if too few utterances have one (<80%)."""
    vecs = _vecs(m["id"])
    utts = [u for u in m.get("utterances", []) if u["id"] in vecs]
    if not utts or len(utts) < 0.8 * len(m.get("utterances", [])):
        return False
    groups = _cosine_cluster([vecs[u["id"]] for u in utts], [u["end"] - u["start"] for u in utts], threshold, k)
    _apply_clusters(m, [[utts[i]["id"] for i in g] for g in groups])
    return True


def _save_audio(mid: str, name: str, data: bytes):
    d = AUDIO / mid
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_bytes(data)


def init():
    with db.conn() as c:
        c.executescript("""
CREATE TABLE IF NOT EXISTS meetings(
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT DEFAULT 'idle',
  created REAL,
  updated REAL,
  duration REAL DEFAULT 0.0,
  speakers TEXT DEFAULT '[]',
  utterances TEXT DEFAULT '[]',
  summary TEXT DEFAULT '',
  summary_data TEXT DEFAULT '{}',
  codex_entry_id TEXT DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_created ON meetings(created);
""")
    _vec_init()


def _extract_voice_features(audio: np.ndarray, sr: int = 16000) -> tuple[np.ndarray, float]:
    """Extracts a 17-dimensional acoustic feature vector and median pitch (F0).
    
    Uses pure NumPy:
    - Pitch (F0) estimation via Normalized Autocorrelation (NACF) on voiced frames (60-400Hz)
    - Spectral Centroid & Spectral Rolloff (85% energy point)
    - 20-band Mel-filterbank energies + Discrete Cosine Transform (DCT-II) -> 13 MFCCs
    """
    if len(audio) < sr * 0.2:
        return np.zeros(17, dtype=np.float32), 150.0

    # Ensure mono float32
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    audio = audio.astype(np.float32)

    # 1. Pitch estimation using normalized autocorrelation (NACF)
    min_lag = int(sr / 400)
    max_lag = int(sr / 60)
    frame_len = int(sr * 0.04)  # 40ms
    hop_len = int(sr * 0.02)    # 20ms
    pitches = []

    for i in range(0, len(audio) - frame_len, hop_len * 2):
        frame = audio[i:i + frame_len]
        w_frame = frame * np.hamming(len(frame))
        corr = np.correlate(w_frame, w_frame, mode="full")
        corr = corr[len(w_frame) - 1:]
        if corr[0] <= 1e-6:
            continue
        corr_norm = corr / corr[0]
        peak_idx = min_lag + int(np.argmax(corr_norm[min_lag:max_lag]))
        peak_val = corr_norm[peak_idx]
        if peak_val > 0.35:
            pitches.append(sr / peak_idx)

    if pitches:
        f0_med = float(np.median(pitches))
        f0_std = float(np.std(pitches))
    else:
        f0_med, f0_std = 150.0, 30.0

    # 2. Spectral features via FFT
    n_fft = 512
    window = np.hanning(n_fft)
    specs = []
    hop = int(sr * 0.015)
    for i in range(0, len(audio) - n_fft, hop):
        frame = audio[i:i + n_fft] * window
        mag = np.abs(np.fft.rfft(frame))
        specs.append(mag)

    if not specs:
        return np.zeros(17, dtype=np.float32), f0_med

    avg_spec = np.mean(specs, axis=0) + 1e-8
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)

    sc = float(np.sum(freqs * avg_spec) / np.sum(avg_spec))
    cum_energy = np.cumsum(avg_spec)
    rolloff_idx = np.searchsorted(cum_energy, 0.85 * cum_energy[-1])
    s_roll = float(freqs[min(rolloff_idx, len(freqs) - 1)])

    # 3. Mel Filterbank (20 bands) + DCT-II -> 13 MFCCs
    def hz_to_mel(hz):
        return 2595.0 * np.log10(1.0 + hz / 700.0)

    def mel_to_hz(mel):
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

    mel_min = hz_to_mel(100.0)
    mel_max = hz_to_mel(sr / 2.0)
    mel_points = np.linspace(mel_min, mel_max, 22)
    hz_points = mel_to_hz(mel_points)
    bin_points = np.floor((n_fft + 1) * hz_points / sr).astype(int)

    fbank = np.zeros((20, n_fft // 2 + 1))
    for m in range(1, 21):
        f_m_minus = bin_points[m - 1]
        f_m = bin_points[m]
        f_m_plus = bin_points[m + 1]
        for k in range(f_m_minus, f_m):
            if f_m != f_m_minus:
                fbank[m - 1, k] = (k - f_m_minus) / (f_m - f_m_minus)
        for k in range(f_m, f_m_plus):
            if f_m_plus != f_m:
                fbank[m - 1, k] = (f_m_plus - k) / (f_m_plus - f_m)

    mel_energies = np.dot(fbank, avg_spec)
    log_mel = np.log(mel_energies + 1e-8)

    n_ceps = 13
    mfcc = np.zeros(n_ceps)
    for k in range(n_ceps):
        mfcc[k] = np.sum(log_mel * np.cos(np.pi * k * (np.arange(20) + 0.5) / 20.0))

    f0_norm = f0_med / 100.0
    f0_std_norm = f0_std / 50.0
    sc_norm = sc / 1000.0
    roll_norm = s_roll / 2000.0
    mfcc_norm = mfcc / 10.0

    vec = np.hstack([f0_norm * 2.5, f0_std_norm, sc_norm, roll_norm, mfcc_norm]).astype(np.float32)
    return vec, f0_med


def _speaker_distance(v1: np.ndarray, v2: np.ndarray) -> float:
    return float(np.linalg.norm(v1 - v2))


def _cluster_vectors_agglomerative(vectors: list[np.ndarray], threshold: float = 1.25) -> list[list[int]]:
    """Hierarchical agglomerative clustering using average linkage."""
    if not vectors:
        return []
    clusters = [[i] for i in range(len(vectors))]
    while len(clusters) > 1:
        best_d = float("inf")
        best_pair = (-1, -1)
        for i in range(len(clusters)):
            c_i = np.mean([vectors[idx] for idx in clusters[i]], axis=0)
            for j in range(i + 1, len(clusters)):
                c_j = np.mean([vectors[idx] for idx in clusters[j]], axis=0)
                d = float(np.linalg.norm(c_i - c_j))
                if d < best_d:
                    best_d = d
                    best_pair = (i, j)
        if best_d > threshold:
            break
        i, j = best_pair
        clusters[i].extend(clusters[j])
        clusters.pop(j)
    return clusters


def _cluster_vectors_fixed_k(vectors: list[np.ndarray], k: int) -> list[list[int]]:
    """Agglomerative clustering merging down to exactly k clusters."""
    if not vectors:
        return []
    k = max(1, min(k, len(vectors)))
    clusters = [[i] for i in range(len(vectors))]
    while len(clusters) > k:
        best_d = float("inf")
        best_pair = (-1, -1)
        for i in range(len(clusters)):
            c_i = np.mean([vectors[idx] for idx in clusters[i]], axis=0)
            for j in range(i + 1, len(clusters)):
                c_j = np.mean([vectors[idx] for idx in clusters[j]], axis=0)
                d = float(np.linalg.norm(c_i - c_j))
                if d < best_d:
                    best_d = d
                    best_pair = (i, j)
        i, j = best_pair
        clusters[i].extend(clusters[j])
        clusters.pop(j)
    return clusters


def _ensure_meeting_vectors(mid: str, m: dict) -> dict[str, list[np.ndarray]]:
    """Reconstructs in-memory speaker vectors from saved utterances if server was restarted."""
    if mid not in _SPEAKER_VECTORS or not _SPEAKER_VECTORS[mid]:
        _SPEAKER_VECTORS[mid] = {}
        for u in m.get("utterances", []):
            sid = u.get("speakerId")
            v = u.get("voiceVector")
            if sid and v:
                _SPEAKER_VECTORS[mid].setdefault(sid, []).append(np.array(v, dtype=np.float32))
    return _SPEAKER_VECTORS[mid]


def _load_meeting(mid: str) -> Optional[dict]:
    with db.conn() as c:
        row = c.execute("SELECT * FROM meetings WHERE id=?", (mid,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["speakers"] = json.loads(d["speakers"] or "[]")
        d["utterances"] = json.loads(d["utterances"] or "[]")
        d["summaryData"] = json.loads(d["summary_data"] or "{}")
        d["codexEntryId"] = d.pop("codex_entry_id", None)
        d.pop("summary_data", None)
        return d


def _save_meeting(m: dict):
    with db.conn() as c:
        c.execute("""
UPDATE meetings SET
  title=?, status=?, updated=?, duration=?,
  speakers=?, utterances=?, summary=?, summary_data=?, codex_entry_id=?
WHERE id=?
""", (
            m.get("title") or "Untitled Meeting",
            m.get("status") or "idle",
            time.time(),
            float(m.get("duration") or 0.0),
            json.dumps(m.get("speakers") or []),
            json.dumps(m.get("utterances") or []),
            m.get("summary") or "",
            json.dumps(m.get("summaryData") or {}),
            m.get("codexEntryId"),
            m["id"],
        ))


@router.get("/meetings")
async def list_meetings():
    """Returns summary list of all recorded meetings."""
    with db.conn() as c:
        rows = c.execute("SELECT id, title, status, created, updated, duration, speakers, utterances, summary, codex_entry_id FROM meetings ORDER BY created DESC").fetchall()
    out = []
    for r in rows:
        speakers = json.loads(r["speakers"] or "[]")
        utterances = json.loads(r["utterances"] or "[]")
        out.append({
            "id": r["id"],
            "title": r["title"] or "Untitled Meeting",
            "status": r["status"] or "idle",
            "created": r["created"],
            "updated": r["updated"],
            "duration": r["duration"] or 0.0,
            "speakerCount": len(speakers),
            "utteranceCount": len(utterances),
            "hasSummary": bool(r["summary"]),
            "codexEntryId": r["codex_entry_id"],
        })
    return out


@router.post("/meetings")
async def create_meeting(req: Request):
    """Creates a new meeting session."""
    body = await req.json() if req.headers.get("content-type", "").startswith("application/json") else {}
    mid = db.new_id("mtg")
    now = time.time()
    title = str(body.get("title") or "").strip() or f"Meeting on {time.strftime('%b %d, %Y %H:%M')}"
    initial_speakers = body.get("speakers") or []

    with db.conn() as c:
        c.execute("""
INSERT INTO meetings(id, title, status, created, updated, duration, speakers, utterances, summary, summary_data)
VALUES(?,?,?,?,?,?,?,?,?,?)
""", (mid, title, "idle", now, now, 0.0, json.dumps(initial_speakers), "[]", "", "{}"))

    _SPEAKER_VECTORS[mid] = {}
    return _load_meeting(mid)


@router.get("/meetings/{mid}")
async def get_meeting(mid: str):
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")
    return m


@router.patch("/meetings/{mid}")
async def patch_meeting(mid: str, req: Request):
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")
    patch = await req.json()

    if "title" in patch:
        m["title"] = str(patch["title"]).strip() or m["title"]
    if "status" in patch:
        m["status"] = patch["status"]
    if "duration" in patch:
        m["duration"] = float(patch["duration"])
    if "speakers" in patch:
        m["speakers"] = patch["speakers"]
    if "utterances" in patch:
        m["utterances"] = patch["utterances"]
    if "summary" in patch:
        m["summary"] = patch["summary"]
    if "summaryData" in patch:
        m["summaryData"] = patch["summaryData"]

    _save_meeting(m)
    return m


@router.delete("/meetings/{mid}")
async def delete_meeting(mid: str):
    with db.conn() as c:
        c.execute("DELETE FROM meetings WHERE id=?", (mid,))
        c.execute("DELETE FROM meeting_vectors WHERE meeting_id=?", (mid,))  # voice prints are biometric: they go too
    _SPEAKER_VECTORS.pop(mid, None)
    _NEURAL.pop(mid, None)
    if re.fullmatch(r"[A-Za-z0-9_-]+", mid or ""):
        import shutil
        shutil.rmtree(AUDIO / mid, ignore_errors=True)
    return {"deleted": True, "id": mid}


@router.post("/meetings/{mid}/utterance")
async def process_utterance(
    mid: str,
    file: UploadFile = File(...),
    start: float = Form(default=0.0),
    end: float = Form(default=0.0),
    speaker_hint: Optional[str] = Form(default=None),
    sensitivity: Optional[str] = Form(default="balanced"),
):
    """Transcribes an audio chunk, extracts speaker features, diarizes the speaker, and appends the utterance."""
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")

    audio_bytes = await file.read()
    if len(audio_bytes) < 400:
        return {"ignored": True, "reason": "audio too short"}

    # 1. Transcribe via Hermes Whisper
    filename = file.filename or "utterance.wav"
    ext = "." + filename.rsplit(".", 1)[-1]
    async with httpx.AsyncClient(timeout=60) as c:
        try:
            r = await c.post(
                f"{HERMES}/stt",
                files={"file": (filename, audio_bytes, file.content_type or "audio/wav")},
            )
            r.raise_for_status()
            stt_data = r.json()
        except Exception as e:
            log.warning("Hermes STT failed for utterance: %s", e)
            raise HTTPException(502, f"HERMES STT error: {e}")

    text = (stt_data.get("text") or "").strip()
    # Filter out empty or noise hallucination
    if not text or re.match(r"^[\W_]*$", text):
        return {"ignored": True, "reason": "no speech detected"}

    clip_duration = float(stt_data.get("duration") or 0.0)
    actual_start = start
    actual_end = end if end > start else start + clip_duration

    # 2. Extract acoustic vector
    vec: Optional[np.ndarray] = None
    pitch_est = 150.0
    try:
        data, sr = sf.read(io.BytesIO(audio_bytes))
        vec, pitch_est = _extract_voice_features(data, sr)
    except Exception as e:
        log.info("Could not extract acoustic features directly via soundfile: %s", e)

    # 2b. Neural voice print (HERMES); the basic features above stay as the fallback
    uid = db.new_id("utt")
    neural = await _embed(audio_bytes, filename)
    nvec = neural[0] if neural else None
    try:
        _save_audio(mid, f"{uid}{Path(filename).suffix or '.wav'}", audio_bytes)
    except OSError as e:
        log.info("couldn't keep utterance audio: %s", e)

    # 3. Speaker assignment & diarization
    vectors_map = _ensure_meeting_vectors(mid, m)
    active_threshold = SENSITIVITY_THRESHOLDS.get(sensitivity or "balanced", SPEAKER_DIST_THRESHOLD)

    assigned_speaker = None
    speakers: list[dict] = m.get("speakers", [])

    if not speaker_hint and nvec is not None:
        # neural: nearest speaker centroid by cosine distance; only a clip long enough to trust starts a new speaker
        prints = _vecs(mid)
        by_spk: dict[str, list[np.ndarray]] = {}
        for u in m.get("utterances", []):
            if u["id"] in prints:
                by_spk.setdefault(u["speakerId"], []).append(prints[u["id"]])
        best, best_d = None, float("inf")
        for spk in speakers:
            if by_spk.get(spk["id"]):
                cent = np.mean(by_spk[spk["id"]], axis=0)
                d = 1.0 - float(nvec @ (cent / (np.linalg.norm(cent) + 1e-9)))
                if d < best_d:
                    best, best_d = spk, d
        if best and (best_d <= COSINE_THRESHOLDS.get(sensitivity or "balanced", 0.50)
                     or clip_duration < NEW_SPEAKER_MIN_SECONDS):
            assigned_speaker = best

    if speaker_hint:
        # User explicitly designated a speaker
        for spk in speakers:
            if spk["id"] == speaker_hint or spk["name"].lower() == speaker_hint.lower():
                assigned_speaker = spk
                break

    if not assigned_speaker and vec is not None and nvec is None:
        # Match against existing speaker centroids (basic pitch/MFCC features: only when HERMES has no voice print)
        best_spk = None
        min_dist = float("inf")

        for spk in speakers:
            spk_id = spk["id"]
            vectors = vectors_map.get(spk_id, [])
            if vectors:
                centroid = np.mean(vectors, axis=0)
                d = _speaker_distance(vec, centroid)
                if d < min_dist:
                    min_dist = d
                    best_spk = spk

        if best_spk and min_dist <= active_threshold:
            assigned_speaker = best_spk

    if not assigned_speaker and (vec is not None or nvec is not None):
        # nobody close enough: a new speaker
        spk_idx = len(speakers) + 1
        while any(sp["id"] == f"spk_{spk_idx}" for sp in speakers):
            spk_idx += 1
        color = SPEAKER_PALETTE[(spk_idx - 1) % len(SPEAKER_PALETTE)]
        assigned_speaker = {
            "id": f"spk_{spk_idx}",
            "name": f"Speaker {spk_idx}",
            "color": color,
            "pitch": round(pitch_est, 1),
            "utteranceCount": 0,
            "totalDuration": 0.0,
        }
        speakers.append(assigned_speaker)

    if not assigned_speaker:
        if speakers:
            assigned_speaker = speakers[0]
        else:
            assigned_speaker = {
                "id": "spk_1",
                "name": "Speaker 1",
                "color": SPEAKER_PALETTE[0],
                "pitch": round(pitch_est, 1),
                "utteranceCount": 0,
                "totalDuration": 0.0,
            }
            speakers.append(assigned_speaker)

    # Update speaker profile
    assigned_speaker["utteranceCount"] = (assigned_speaker.get("utteranceCount") or 0) + 1
    assigned_speaker["totalDuration"] = round((assigned_speaker.get("totalDuration") or 0.0) + clip_duration, 1)
    if pitch_est > 60:
        assigned_speaker["pitch"] = round(pitch_est, 1)

    if vec is not None:
        vectors_map.setdefault(assigned_speaker["id"], []).append(vec)

    # 4. Create and store utterance
    utt = {
        "id": uid,
        "speakerId": assigned_speaker["id"],
        "speakerName": assigned_speaker["name"],
        "start": round(actual_start, 2),
        "end": round(actual_end, 2),
        "text": text,
        "confidence": 0.95,
        "pitch": round(pitch_est, 1) if pitch_est > 0 else None,
        "voiceVector": vec.tolist() if vec is not None else None,
    }

    m["utterances"].append(utt)
    m["speakers"] = speakers
    m["duration"] = max(float(m.get("duration") or 0.0), actual_end)
    m["status"] = "recording"
    if nvec is not None:
        _vec_put(mid, uid, nvec)
        _set_diarizer(mid, NEURAL)
        if len(m["utterances"]) % RECLUSTER_EVERY == 0:  # early guesses get revisited as voices become clearer
            _neural_recluster(m, COSINE_THRESHOLDS.get(sensitivity or "balanced", 0.50))
            utt = next(u for u in m["utterances"] if u["id"] == uid)
            speakers = m["speakers"]
    _save_meeting(m)

    return {
        "utterance": utt,
        "speakers": speakers,
        "duration": m["duration"],
    }



@router.post("/meetings/{mid}/upload-audio")
async def upload_meeting_audio(mid: str, file: UploadFile = File(...)):
    """Processes an entire recorded meeting file, transcribing and diarizing it into turns."""
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")

    m["status"] = "processing"
    _save_meeting(m)

    audio_bytes = await file.read()
    filename = file.filename or "meeting.wav"
    import transcribe
    if transcribe.is_video(filename) or Path(filename).suffix.lower() in (".mkv", ".mov", ".m4v", ".avi"):
        # a recording with a picture: ffmpeg in the sandbox strips the audio track first (the host has no ffmpeg)
        import tempfile
        tmp = Path(tempfile.mkdtemp(prefix="meeting-", dir=db.DATA / "cells"))
        try:
            src = tmp / Path(filename).name
            src.write_bytes(audio_bytes)
            wav = await transcribe.to_wav(src, tmp / "meeting.wav")
            audio_bytes, filename = wav.read_bytes(), "meeting.wav"
        except RuntimeError as e:
            m["status"] = "idle"
            _save_meeting(m)
            raise HTTPException(400, f"Couldn't extract the audio: {e}")
        finally:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)

    # Transcribe via Hermes Whisper
    async with httpx.AsyncClient(timeout=300) as c:
        r = await c.post(
            f"{HERMES}/stt",
            files={"file": (filename, audio_bytes, file.content_type or "audio/wav")},
        )
        if r.status_code != 200:
            m["status"] = "idle"
            _save_meeting(m)
            raise HTTPException(502, f"STT failed: {r.text[:200]}")
        stt_result = r.json()

    segments = stt_result.get("segments") or []
    if not segments:
        m["status"] = "idle"
        _save_meeting(m)
        return m

    # Read audio into numpy to slice segments
    audio_data = None
    sr = 16000
    try:
        audio_data, sr = sf.read(io.BytesIO(audio_bytes))
        if audio_data.ndim > 1:
            audio_data = audio_data.mean(axis=1)
    except Exception as e:
        log.info("Direct soundfile read failed, diarizing with duration heuristic: %s", e)

    speakers: list[dict] = []
    utterances: list[dict] = []
    vectors_by_speaker: dict[str, list[np.ndarray]] = {}

    for seg in segments:
        s_start = float(seg["start"])
        s_end = float(seg["end"])
        s_text = seg["text"].strip()
        if not s_text:
            continue

        vec = None
        pitch = 150.0
        if audio_data is not None:
            idx_start = max(0, int(s_start * sr))
            idx_end = min(len(audio_data), int(s_end * sr))
            if idx_end - idx_start > sr * 0.2:
                slice_audio = audio_data[idx_start:idx_end]
                vec, pitch = _extract_voice_features(slice_audio, sr)

        # Match or create speaker
        assigned_spk = None
        if vec is not None and speakers:
            best_spk = None
            min_dist = float("inf")
            for spk in speakers:
                vs = vectors_by_speaker.get(spk["id"], [])
                if vs:
                    centroid = np.mean(vs, axis=0)
                    d = _speaker_distance(vec, centroid)
                    if d < min_dist:
                        min_dist = d
                        best_spk = spk
            if best_spk and min_dist <= SPEAKER_DIST_THRESHOLD:
                assigned_spk = best_spk

        if not assigned_spk:
            spk_idx = len(speakers) + 1
            color = SPEAKER_PALETTE[(spk_idx - 1) % len(SPEAKER_PALETTE)]
            assigned_spk = {
                "id": f"spk_{spk_idx}",
                "name": f"Speaker {spk_idx}",
                "color": color,
                "pitch": round(pitch, 1),
                "utteranceCount": 0,
                "totalDuration": 0.0,
            }
            speakers.append(assigned_spk)

        assigned_spk["utteranceCount"] += 1
        assigned_spk["totalDuration"] = round(assigned_spk["totalDuration"] + (s_end - s_start), 1)
        if vec is not None:
            vectors_by_speaker.setdefault(assigned_spk["id"], []).append(vec)

        utterances.append({
            "id": db.new_id("utt"),
            "speakerId": assigned_spk["id"],
            "speakerName": assigned_spk["name"],
            "start": round(s_start, 2),
            "end": round(s_end, 2),
            "text": s_text,
            "confidence": 0.95,
            "pitch": round(pitch, 1) if pitch > 0 else None,
            "voiceVector": vec.tolist() if vec is not None else None,
        })

    total_dur = float(stt_result.get("duration") or (utterances[-1]["end"] if utterances else 0.0))
    m["speakers"] = speakers
    m["utterances"] = utterances
    m["duration"] = round(total_dur, 2)
    m["status"] = "completed"
    _SPEAKER_VECTORS[mid] = vectors_by_speaker

    # neural voice prints for every segment in one HERMES call; they replace the basic grouping above when they work
    try:
        _save_audio(mid, f"source{Path(filename).suffix or '.wav'}", audio_bytes)
    except OSError as e:
        log.info("couldn't keep meeting audio: %s", e)
    prints = await _embed(audio_bytes, filename, [[u["start"], u["end"]] for u in utterances])
    if prints:
        for u, v in zip(utterances, prints):
            if v is not None:
                _vec_put(mid, u["id"], v)
        if _neural_recluster(m, COSINE_THRESHOLDS["balanced"]):
            _set_diarizer(mid, NEURAL)
    _save_meeting(m)
    m["diarizer"] = _load_meeting(mid).get("diarizer")
    return m


@router.post("/meetings/{mid}/rediarize")
async def rediarize_meeting(mid: str, req: Request):
    """Re-clusters and separates speakers across all utterances using voice profiles."""
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")

    body = await req.json() if req.headers.get("content-type", "").startswith("application/json") else {}
    num_speakers = body.get("numSpeakers")
    sensitivity = body.get("sensitivity") or "balanced"
    threshold = SENSITIVITY_THRESHOLDS.get(sensitivity, SPEAKER_DIST_THRESHOLD)

    utterances = m.get("utterances", [])
    if not utterances:
        return m
    # neural voice prints when (nearly) every utterance has one; the basic features otherwise
    k = int(num_speakers) if num_speakers and int(num_speakers) >= 1 else None
    if _neural_recluster(m, COSINE_THRESHOLDS.get(sensitivity, 0.50), k):
        _SPEAKER_VECTORS.pop(mid, None)
        _save_meeting(m)
        _set_diarizer(mid, NEURAL)
        m["diarizer"] = NEURAL
        return m

    # Filter utterances that have voice vectors
    indices_with_vectors = []
    vectors = []
    for idx, u in enumerate(utterances):
        v = u.get("voiceVector")
        if v:
            indices_with_vectors.append(idx)
            vectors.append(np.array(v, dtype=np.float32))

    if not vectors:
        raise HTTPException(400, "No acoustic voice vectors found in this meeting's utterances to re-cluster.")

    if num_speakers and int(num_speakers) >= 1:
        clusters = _cluster_vectors_fixed_k(vectors, int(num_speakers))
    else:
        clusters = _cluster_vectors_agglomerative(vectors, threshold=threshold)

    # basic features: also fold tiny clusters into their nearest neighbour (they were most of the 51 "speakers")
    if not num_speakers and len(clusters) > 1:
        durs = [max(0.0, float(utterances[i]["end"]) - float(utterances[i]["start"])) for i in indices_with_vectors]
        big = [c for c in clusters if sum(durs[x] for x in c) > MERGE_MAX_SECONDS or len(c) > MERGE_MAX_UTTS]
        if big:
            cents = [np.mean([vectors[x] for x in c], axis=0) for c in big]
            for c in (c for c in clusters if c not in big):
                v = np.mean([vectors[x] for x in c], axis=0)
                big[int(np.argmin([float(np.linalg.norm(v - ct)) for ct in cents]))].extend(c)
            clusters = big
    _apply_clusters(m, [[utterances[indices_with_vectors[x]]["id"] for x in c] for c in clusters])
    _SPEAKER_VECTORS.pop(mid, None)
    _save_meeting(m)
    m["diarizer"] = "legacy-17d"
    return m


@router.post("/meetings/{mid}/reembed")
async def reembed_meeting(mid: str, req: Request):
    """Compute neural voice prints again from the audio kept for this meeting, then re-cluster. 409 when the meeting
    kept no audio (recorded before it was kept); re-diarize with a speaker count works for those."""
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")
    body = await req.json() if req.headers.get("content-type", "").startswith("application/json") else {}
    d = AUDIO / mid
    files = {f.stem: f for f in d.glob("*")} if d.is_dir() else {}
    utts = m.get("utterances", [])
    got = 0
    if "source" in files:
        prints = await _embed(files["source"].read_bytes(), files["source"].name, [[u["start"], u["end"]] for u in utts])
        for u, v in zip(utts, prints or []):
            if v is not None:
                _vec_put(mid, u["id"], v)
                got += 1
    else:
        for u in utts:
            f = files.get(u["id"])
            if f:
                prints = await _embed(f.read_bytes(), f.name)
                if prints and prints[0] is not None:
                    _vec_put(mid, u["id"], prints[0])
                    got += 1
    if not got:
        raise HTTPException(409, "This meeting has no saved audio (or HERMES couldn't read it); use Re-diarize with "
                                 "a speaker count instead.")
    k = int(body["numSpeakers"]) if body.get("numSpeakers") else None
    if not _neural_recluster(m, COSINE_THRESHOLDS.get(body.get("sensitivity") or "balanced", 0.50), k):
        raise HTTPException(409, f"Only {got} of {len(utts)} utterances have usable audio; not enough to re-identify.")
    _SPEAKER_VECTORS.pop(mid, None)
    _save_meeting(m)
    _set_diarizer(mid, NEURAL)
    m["diarizer"] = NEURAL
    return m


@router.patch("/meetings/{mid}/utterances/{uid}")
async def reassign_utterance(mid: str, uid: str, req: Request):
    """Reassigns a specific utterance to a different speaker."""
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")

    body = await req.json()
    new_spk_id = body.get("speakerId")
    if not new_spk_id:
        raise HTTPException(400, "speakerId is required")

    target_spk = next((s for s in m.get("speakers", []) if s["id"] == new_spk_id), None)
    if not target_spk:
        raise HTTPException(404, "Target speaker not found")

    target_u = next((u for u in m.get("utterances", []) if u["id"] == uid), None)
    if not target_u:
        raise HTTPException(404, "Utterance not found")

    old_spk_id = target_u["speakerId"]
    target_u["speakerId"] = target_spk["id"]
    target_u["speakerName"] = target_spk["name"]

    # Recalculate speaker counts & durations
    for s in m.get("speakers", []):
        s_utts = [u for u in m["utterances"] if u["speakerId"] == s["id"]]
        s["utteranceCount"] = len(s_utts)
        s["totalDuration"] = round(sum(max(0.0, float(u.get("end", 0)) - float(u.get("start", 0))) for u in s_utts), 1)

    # Update vector store
    vectors_map = _ensure_meeting_vectors(mid, m)
    if target_u.get("voiceVector") and mid in _SPEAKER_VECTORS:
        vec = np.array(target_u["voiceVector"], dtype=np.float32)
        if old_spk_id in vectors_map:
            vectors_map[old_spk_id] = [v for v in vectors_map[old_spk_id] if not np.array_equal(v, vec)]
        vectors_map.setdefault(target_spk["id"], []).append(vec)

    _save_meeting(m)
    return m


@router.post("/meetings/{mid}/summarize")
async def summarize_meeting(mid: str):
    """Compiles an executive summary with key decisions, action items, and topic breakdown using ShellB-Swift."""
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")

    utterances = m.get("utterances", [])
    if not utterances:
        raise HTTPException(400, "Meeting has no transcript to summarize.")

    # Build formatted transcript
    lines = []
    for u in utterances:
        s_min = int(u["start"]) // 60
        s_sec = int(u["start"]) % 60
        ts = f"{s_min:02d}:{s_sec:02d}"
        lines.append(f"[{ts}] {u['speakerName']}: {u['text']}")
    transcript_text = "\n".join(lines)

    speakers_list = ", ".join(f"{s['name']}" for s in m.get("speakers", []))

    system_prompt = (
        "You are an expert Executive Meeting Secretary. "
        "Your task is to analyze the provided diarized meeting transcript and produce an authoritative, "
        "structured meeting record with action items, key decisions, and topic summaries.\n\n"
        "Return a strictly valid JSON object with the following schema:\n"
        "{\n"
        '  "title": "A crisp, descriptive title for this meeting (e.g. Q4 Infrastructure Architecture & Rollout)",\n'
        '  "tldr": "A 2 to 3 paragraph executive summary synthesizing the core goals, discussion arc, and outcomes.",\n'
        '  "participants": [\n'
        '    {"name": "Speaker Name", "role": "Inferred role / perspective", "contribution": "Key points raised"}\n'
        "  ],\n"
        '  "topics": [\n'
        '    {"title": "Topic Title", "notes": ["Key point 1", "Key point 2"]}\n'
        "  ],\n"
        '  "decisions": ["Definitive decision 1", "Definitive decision 2"],\n'
        '  "actionItems": [\n'
        '    {"id": "act_1", "task": "Task description", "owner": "Assigned Person", "priority": "high|medium|low", "deadline": "Timeframe if mentioned or TBD"}\n'
        "  ],\n"
        '  "openQuestions": ["Unresolved topic or follow-up question"]\n'
        "}\n"
        "Be specific, capture concrete technical details, and assign every action item to the appropriate person."
    )

    user_prompt = (
        f"Meeting Title: {m.get('title', 'Meeting')}\n"
        f"Identified Speakers: {speakers_list}\n\n"
        f"Transcript:\n{transcript_text}"
    )

    payload = {
        "model": "ShellB-Swift",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.2, "num_ctx": 32768},
    }

    try:
        async with httpx.AsyncClient(timeout=180) as c:
            r = await c.post(f"{OLLAMA}/api/chat", json=payload)
            r.raise_for_status()
            res_content = r.json()["message"]["content"]
            summary_data = json.loads(res_content)
    except Exception as e:
        log.warning("Ollama JSON meeting summary failed, falling back to text prompt: %s", e)
        # Fallback to plain prompt
        payload["format"] = ""
        payload["messages"][0]["content"] = (
            "You are an expert Executive Meeting Secretary. Write an executive summary of this meeting in Markdown, "
            "including Executive Summary, Key Decisions, Action Items (with Owner and Priority), and Discussion Topics."
        )
        async with httpx.AsyncClient(timeout=180) as c:
            r = await c.post(f"{OLLAMA}/api/chat", json=payload)
            r.raise_for_status()
            raw_text = r.json()["message"]["content"]
            summary_data = {
                "title": m.get("title") or "Meeting Summary",
                "tldr": raw_text[:500],
                "participants": [],
                "topics": [],
                "decisions": [],
                "actionItems": [],
                "openQuestions": [],
            }

    # Format Markdown document
    md_lines = []
    title = summary_data.get("title") or m.get("title") or "Meeting Summary"
    m["title"] = title
    md_lines.append(f"# {title}\n")
    md_lines.append(f"**Date**: {time.strftime('%B %d, %Y', time.localtime(m['created']))}  ")
    md_lines.append(f"**Duration**: {int(m.get('duration', 0)) // 60}m {int(m.get('duration', 0)) % 60}s  ")
    md_lines.append(f"**Participants**: {', '.join(s['name'] for s in m.get('speakers', []))}\n")

    md_lines.append("## Executive Summary\n")
    md_lines.append(f"{summary_data.get('tldr', '')}\n")

    if summary_data.get("decisions"):
        md_lines.append("## Key Decisions Made\n")
        for i, d in enumerate(summary_data["decisions"], 1):
            md_lines.append(f"{i}. **{d}**")
        md_lines.append("")

    if summary_data.get("actionItems"):
        md_lines.append("## Action Items & Next Steps\n")
        md_lines.append("| Task | Owner | Priority | Timeline |")
        md_lines.append("| :--- | :--- | :--- | :--- |")
        for item in summary_data["actionItems"]:
            task = item.get("task", "")
            owner = item.get("owner", "Unassigned")
            prio = item.get("priority", "medium").upper()
            deadline = item.get("deadline", "TBD")
            md_lines.append(f"| {task} | **{owner}** | `{prio}` | {deadline} |")
        md_lines.append("")

    if summary_data.get("topics"):
        md_lines.append("## Discussion Breakdown\n")
        for topic in summary_data["topics"]:
            md_lines.append(f"### {topic.get('title', 'Topic')}")
            for n in topic.get("notes", []):
                md_lines.append(f"- {n}")
            md_lines.append("")

    if summary_data.get("openQuestions"):
        md_lines.append("## Open Questions & Follow-ups\n")
        for q in summary_data["openQuestions"]:
            md_lines.append(f"- [ ] {q}")
        md_lines.append("")

    summary_md = "\n".join(md_lines)

    m["summary"] = summary_md
    m["summaryData"] = summary_data
    m["status"] = "completed"
    _save_meeting(m)

    return {
        "summary": summary_md,
        "summaryData": summary_data,
        "title": title,
    }


@router.post("/meetings/{mid}/suggest-names")
async def suggest_speaker_names(mid: str):
    """Uses LLM to detect names mentioned in conversational greetings or intros."""
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")

    utterances = m.get("utterances", [])[:40]  # First 40 turns usually contain greetings/intros
    if not utterances:
        return {"suggestions": {}}

    lines = [f"{u['speakerName']} ({u['speakerId']}): {u['text']}" for u in utterances]
    dialogue = "\n".join(lines)

    prompt = (
        "Based on conversational cues in this dialogue (greetings, introductions, 'Hi this is X', 'Thanks Y', etc.), "
        "infer the real person's name for each speaker ID where discernible.\n"
        f"Speakers: {[s['id'] for s in m.get('speakers', [])]}\n\n"
        f"Dialogue snippet:\n{dialogue}\n\n"
        'Return ONLY a JSON map of {"speaker_id": "Real Name"}. Do not guess if there is no clue.'
    )

    try:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(
                f"{OLLAMA}/api/chat",
                json={
                    "model": "ShellB-Swift",
                    "messages": [{"role": "user", "content": prompt}],
                    "format": "json",
                    "stream": False,
                    "options": {"temperature": 0.1},
                },
            )
            r.raise_for_status()
            sug = json.loads(r.json()["message"]["content"])
            return {"suggestions": sug}
    except Exception as e:
        log.warning("Name suggestion failed: %s", e)
        return {"suggestions": {}}


@router.post("/meetings/{mid}/save-to-codex")
async def save_meeting_to_codex(mid: str):
    """Saves the meeting summary and transcript into the Codex reference shelf as a permanent Note."""
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")

    title = m.get("title") or "Meeting Record"
    summary_md = m.get("summary") or "## Meeting Summary\n*(No summary generated yet)*\n"

    # Append full transcript
    transcript_md = "\n\n## Full Diarized Transcript\n\n"
    for u in m.get("utterances", []):
        s_min = int(u["start"]) // 60
        s_sec = int(u["start"]) % 60
        ts = f"{s_min:02d}:{s_sec:02d}"
        transcript_md += f"**[{ts}] {u['speakerName']}**: {u['text']}\n\n"

    full_body = summary_md + transcript_md
    tags = ["meeting", "secretary", "summary", "notes"]
    for spk in m.get("speakers", []):
        tags.append(spk["name"].lower().replace(" ", "-"))

    entry = codex.create({
        "kind": "note",
        "title": f"Meeting: {title}",
        "body": full_body,
        "tags": tags,
    })

    m["codexEntryId"] = entry["id"]
    _save_meeting(m)

    return {"ok": True, "codexEntry": entry}


@router.post("/meetings/{mid}/ask")
async def ask_meeting(mid: str, req: Request):
    """Answers user questions grounded strictly in the meeting transcript and summary."""
    m = _load_meeting(mid)
    if not m:
        raise HTTPException(404, "Meeting not found")

    body = await req.json()
    question = str(body.get("question") or "").strip()
    if not question:
        raise HTTPException(400, "Question is required")

    transcript_lines = []
    for u in m.get("utterances", []):
        s_min = int(u["start"]) // 60
        s_sec = int(u["start"]) % 60
        transcript_lines.append(f"[{s_min:02d}:{s_sec:02d}] {u['speakerName']}: {u['text']}")
    transcript_text = "\n".join(transcript_lines)

    context = f"Meeting Title: {m.get('title')}\n\nSummary:\n{m.get('summary', '')}\n\nTranscript:\n{transcript_text}"

    messages = [
        {
            "role": "system",
            "content": (
                "You are an intelligent executive meeting secretary. Answer the user's question using ONLY the facts "
                "from the meeting summary and transcript. Be direct, cite speakers when relevant, and mention timestamps if helpful."
            ),
        },
        {"role": "user", "content": f"Meeting Record:\n{context}\n\nQuestion: {question}"},
    ]

    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            f"{OLLAMA}/api/chat",
            json={
                "model": "ShellB-Swift",
                "messages": messages,
                "stream": False,
                "options": {"temperature": 0.2, "num_ctx": 32768},
            },
        )
        r.raise_for_status()
        answer = r.json()["message"]["content"]

    return {"answer": answer}
