#!/usr/bin/env python3
"""
Persistent local voice worker for Speaking AI Professor.
Supports:
  - Kokoro-82M neural TTS via mlx-audio (Apple Silicon GPU, ~120ms/sentence, 24kHz PCM)
  - Offline STT via mlx-whisper (Apple Silicon GPU, Spanish & English)
Communicates via JSON lines on stdin/stdout so models stay hot in RAM.
"""

import base64
import io
import json
import os
import sys
import tempfile
import traceback

kokoro_model = None
kokoro_backend = None  # "mlx" | "onnx" | "pytorch"
kokoro_loaded_id = None
kokoro_call_count = 0
whisper_loaded = False
faster_whisper_model = None

# Reserve original stdout exclusively for JSON-RPC lines; send all library prints to stderr
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr


def emit(obj):
    _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()


def to_pcm16_bytes(audio_array):
    import numpy as np

    arr = np.asarray(audio_array, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return b""
    arr = np.clip(arr, -1.0, 1.0)
    pcm16 = (arr * 32767.0).astype(np.int16)
    return pcm16.tobytes()


def _configure_mlx_gpu_hygiene():
    """Keep Kokoro hot on Apple Silicon Metal GPU while capping Metal scratch cache at 256 MB
    so it never steals Unified RAM away from Ollama's weights & KV-cache on 24 GB M4 Pro."""
    try:
        import mlx.core as mx
        mx.set_default_device(mx.gpu)
        limit = 256 * 1024 * 1024
        if hasattr(mx, "set_cache_limit"):
            mx.set_cache_limit(limit)
        elif hasattr(mx, "metal") and hasattr(mx.metal, "set_cache_limit"):
            mx.metal.set_cache_limit(limit)
    except Exception:
        pass


def _release_mlx_scratch_cache():
    try:
        import mlx.core as mx
        if hasattr(mx, "clear_cache"):
            mx.clear_cache()
        elif hasattr(mx, "metal") and hasattr(mx.metal, "clear_cache"):
            mx.metal.clear_cache()
    except Exception:
        pass


def ensure_kokoro(lang_code="e"):
    global kokoro_model, kokoro_backend, kokoro_loaded_id
    if kokoro_model is not None and (kokoro_backend != "pytorch" or kokoro_loaded_id == lang_code):
        return kokoro_model, kokoro_backend

    import importlib.util

    # 1. Apple Silicon MLX backend (fastest Metal GPU path on macOS arm64)
    if importlib.util.find_spec("mlx_audio") is not None:
        _configure_mlx_gpu_hygiene()
        hb_lib = "/opt/homebrew/lib/libespeak-ng.dylib"
        hb_data = "/opt/homebrew/share/espeak-ng-data"
        if os.path.exists(hb_lib):
            os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = hb_lib
        if os.path.exists(hb_data):
            os.environ["ESPEAK_DATA_PATH"] = hb_data
            try:
                from phonemizer.backend.espeak.wrapper import EspeakWrapper
                if hasattr(EspeakWrapper, "set_library") and os.path.exists(hb_lib):
                    EspeakWrapper.set_library(hb_lib)
                if hasattr(EspeakWrapper, "set_data_path"):
                    EspeakWrapper.set_data_path(hb_data)
            except Exception:
                pass

        from mlx_audio.tts.utils import load_model

        model_id = os.environ.get("KOKORO_MODEL_ID", "mlx-community/Kokoro-82M-bf16")
        kokoro_model = load_model(model_id)
        kokoro_backend = "mlx"
        kokoro_loaded_id = model_id
        return kokoro_model, kokoro_backend

    # 2. Cross-platform PyTorch Kokoro-82M backend (Windows / Linux / NVIDIA CUDA / CPU)
    if importlib.util.find_spec("kokoro") is not None:
        from kokoro import KPipeline

        kokoro_model = KPipeline(lang_code=lang_code)
        kokoro_backend = "pytorch"
        kokoro_loaded_id = lang_code
        return kokoro_model, kokoro_backend

    # 3. Cross-platform ONNX Kokoro backend (Windows / Linux lightweight CPU)
    if importlib.util.find_spec("kokoro_onnx") is not None:
        from kokoro_onnx import Kokoro

        model_path = os.environ.get("KOKORO_ONNX_MODEL", "")
        voices_path = os.environ.get("KOKORO_ONNX_VOICES", "")
        if not (model_path and voices_path and os.path.exists(model_path) and os.path.exists(voices_path)):
            cache_base = os.path.join(os.path.expanduser("~"), ".cache", "speaking-professor", "kokoro-onnx")
            os.makedirs(cache_base, exist_ok=True)
            model_path = os.path.join(cache_base, "kokoro-v1.0.onnx")
            voices_path = os.path.join(cache_base, "voices-v1.0.bin")
            if not (os.path.exists(model_path) and os.path.exists(voices_path)):
                import urllib.request
                base_url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
                if not os.path.exists(model_path):
                    urllib.request.urlretrieve(f"{base_url}/kokoro-v1.0.onnx", model_path)
                if not os.path.exists(voices_path):
                    urllib.request.urlretrieve(f"{base_url}/voices-v1.0.bin", voices_path)
        kokoro_model = Kokoro(model_path, voices_path)
        kokoro_backend = "onnx"
        kokoro_loaded_id = model_path
        return kokoro_model, kokoro_backend

    raise RuntimeError("No Kokoro TTS backend installed (mlx_audio, kokoro, or kokoro_onnx)")


def prepare_text_for_kokoro(text, lang_code="e"):
    import re

    t = str(text or "").strip()
    if not t:
        return ""
    if lang_code == "e":
        replacements = [
            ("Σ", " suma de "),
            ("Δ", " variación de "),
            ("⇒", ", entonces "),
            ("→", " hacia "),
            ("∝", " proporcional a "),
            ("≈", " aproximadamente "),
            ("≠", " distinto de "),
            ("≤", " menor o igual que "),
            ("≥", " mayor o igual que "),
            ("±", " más menos "),
            ("×", " por "),
            ("·", " por "),
            ("²", " al cuadrado"),
            ("^2", " al cuadrado"),
            ("³", " al cubo"),
            ("^3", " al cubo"),
            ("√", " raíz cuadrada de "),
            ("°", " grados"),
            ("%", " por ciento"),
            ("α", " alfa "),
            ("β", " beta "),
            ("θ", " teta "),
            ("ω", " omega "),
            ("μ", " mu "),
            ("π", " pi "),
        ]
        for k, v in replacements:
            t = t.replace(k, v)
        # Make engineering subscripts sound natural in Spanish (e.g. h_CG -> h CG, F_z -> F sub z)
        t = re.sub(r"\b([A-Za-z])_([A-Za-z0-9]+)\b", r"\1 sub \2", t)
        t = t.replace("_", " ")
    t = re.sub(r"[ \t]+", " ", t).strip()

    # EspeakG2P(language='es') warns that long unsplit text can be truncated unless split with '\n'.
    # Split cleanly into ~140-char chunks at natural punctuation boundaries.
    lines_out = []
    for para in t.splitlines():
        para = para.strip()
        if not para:
            continue
        while len(para) > 195:
            cut = -1
            for sep in [". ", "; ", ": ", ", ", " "]:
                idx = para.rfind(sep, 65, 195)
                if idx != -1:
                    cut = idx + len(sep)
                    break
            if cut == -1:
                cut = 195
            lines_out.append(para[:cut].strip())
            para = para[cut:].strip()
        if para:
            lines_out.append(para)
    return "\n".join(lines_out)


def _apply_edge_fade(arr, sr=24000, fade_ms=6):
    import numpy as np

    n = int(sr * fade_ms / 1000)
    if arr.size < n * 2 or n <= 1:
        return arr
    ramp = 0.5 * (1.0 - np.cos(np.linspace(0.0, np.pi, n, dtype=np.float32)))
    out = arr.copy()
    out[:n] *= ramp
    out[-n:] *= ramp[::-1]
    return out


def _split_expressive_clauses(prepared_text):
    """Split text on expressive pauses ('...', ' — ', newlines) returning [(clause, pause_ms_after)]."""
    import re

    # Replace expressive markers with explicit tokens
    marked = re.sub(r"\.\.\.+|…", " <<PAUSE_260>> ", prepared_text)
    marked = re.sub(r"\s+—\s+|\s+–\s+", " <<PAUSE_160>> ", marked)
    marked = marked.replace("\n", " <<PAUSE_180>> ")
    tokens = re.split(r"(<<PAUSE_\d+>>)", marked)

    segments = []
    for tok in tokens:
        m = re.match(r"^<<PAUSE_(\d+)>>$", tok)
        if m:
            if segments:
                segments[-1] = (segments[-1][0], max(segments[-1][1], int(m.group(1))))
        else:
            clause = re.sub(r"\s+", " ", tok).strip(" ,;-")
            if clause:
                segments.append((clause, 0))
    return segments


def synthesize_kokoro(text, voice="em_alex", lang_code="e", speed=1.03):
    import numpy as np

    prepared = prepare_text_for_kokoro(text, lang_code=lang_code)
    if not prepared:
        return b"", 24000

    model, backend = ensure_kokoro(lang_code=lang_code)
    clauses = _split_expressive_clauses(prepared)
    if not clauses:
        return b"", 24000

    clamped_speed = max(0.85, min(1.20, float(speed)))
    chunks = []
    sample_rate = 24000

    for clause_text, pause_ms in clauses:
        clause_audio = []
        if backend == "mlx":
            for result in model.generate(
                text=clause_text,
                voice=voice,
                speed=clamped_speed,
                lang_code=lang_code,
            ):
                audio = getattr(result, "audio", None)
                if audio is None and isinstance(result, dict):
                    audio = result.get("audio")
                sr = getattr(result, "sample_rate", None)
                if sr:
                    sample_rate = int(sr)
                if audio is not None:
                    arr = np.asarray(audio, dtype=np.float32).reshape(-1)
                    if arr.size > 0:
                        clause_audio.append(arr)
        elif backend == "pytorch":
            for _, _, audio in model(clause_text, voice=voice, speed=clamped_speed):
                if audio is not None:
                    arr = np.asarray(audio, dtype=np.float32).reshape(-1)
                    if arr.size > 0:
                        clause_audio.append(arr)
        elif backend == "onnx":
            onnx_lang = "es" if lang_code == "e" else "en-us"
            samples, sr = model.create(clause_text, voice=voice, speed=clamped_speed, lang=onnx_lang)
            if sr:
                sample_rate = int(sr)
            if samples is not None:
                arr = np.asarray(samples, dtype=np.float32).reshape(-1)
                if arr.size > 0:
                    clause_audio.append(arr)

        if clause_audio:
            joined = _apply_edge_fade(np.concatenate(clause_audio), sr=sample_rate)
            chunks.append(joined)
            if pause_ms > 0:
                gap_samples = int(sample_rate * pause_ms / 1000)
                if gap_samples > 0:
                    chunks.append(np.zeros(gap_samples, dtype=np.float32))

    global kokoro_call_count
    if not chunks:
        return b"", sample_rate
    full = np.concatenate(chunks)
    kokoro_call_count += 1
    if backend == "mlx" and kokoro_call_count % 8 == 0:
        _release_mlx_scratch_cache()
    return to_pcm16_bytes(full), sample_rate


def transcribe_whisper(wav_bytes, language=None):
    global faster_whisper_model
    import importlib.util

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tf.write(wav_bytes)
        tmp_path = tf.name
    try:
        if importlib.util.find_spec("mlx_whisper") is not None:
            import mlx_whisper

            model_id = os.environ.get("MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
            kwargs = {"path_or_hf_repo": model_id}
            if language and language in ("es", "en"):
                kwargs["language"] = language
            res = mlx_whisper.transcribe(tmp_path, **kwargs)
            return (res.get("text") or "").strip()

        if importlib.util.find_spec("faster_whisper") is not None:
            from faster_whisper import WhisperModel

            if faster_whisper_model is None:
                fw_name = os.environ.get("FASTER_WHISPER_MODEL", "small")
                faster_whisper_model = WhisperModel(fw_name, device="auto", compute_type="int8")
            kwargs = {}
            if language and language in ("es", "en"):
                kwargs["language"] = language
            segments, _ = faster_whisper_model.transcribe(tmp_path, **kwargs)
            return " ".join((seg.text or "").strip() for seg in segments).strip()

        raise RuntimeError("No local Whisper backend installed (mlx_whisper or faster_whisper)")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def check_capabilities():
    import importlib.util

    kokoro_b = (
        "mlx"
        if importlib.util.find_spec("mlx_audio") is not None
        else "pytorch"
        if importlib.util.find_spec("kokoro") is not None
        else "onnx"
        if importlib.util.find_spec("kokoro_onnx") is not None
        else None
    )
    whisper_b = (
        "mlx"
        if importlib.util.find_spec("mlx_whisper") is not None
        else "faster-whisper"
        if importlib.util.find_spec("faster_whisper") is not None
        else None
    )
    return {
        "kokoro": kokoro_b is not None,
        "kokoroBackend": kokoro_b,
        "whisper": whisper_b is not None,
        "whisperBackend": whisper_b,
    }


def main():
    caps = check_capabilities()
    emit({"type": "ready", "capabilities": caps})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            cmd = req.get("cmd")

            if cmd == "ping":
                emit({"id": req_id, "ok": True, "capabilities": check_capabilities()})
            elif cmd == "warmup":
                ensure_kokoro()
                # Trigger 1 tiny silent pass to pre-compile Apple Silicon Metal shaders before class starts
                try:
                    synthesize_kokoro("Hola.", voice="em_alex", lang_code="e", speed=1.03)
                except Exception:
                    pass
                emit({"id": req_id, "ok": True, "warmed": True})
            elif cmd == "tts":
                text = (req.get("text") or "").strip()
                voice = req.get("voice") or "em_alex"
                lang_code = req.get("lang_code") or ("e" if voice.startswith(("em_", "ef_")) else "a")
                speed = req.get("speed", 1.04)
                pcm_bytes, sr = synthesize_kokoro(text, voice=voice, lang_code=lang_code, speed=speed)
                emit({
                    "id": req_id,
                    "ok": True,
                    "sampleRate": sr,
                    "pcmBase64": base64.b64encode(pcm_bytes).decode("ascii"),
                })
            elif cmd == "stt":
                wav_b64 = req.get("wavBase64") or ""
                language = req.get("language")
                wav_bytes = base64.b64decode(wav_b64)
                text = transcribe_whisper(wav_bytes, language=language)
                emit({"id": req_id, "ok": True, "text": text})
            else:
                emit({"id": req_id, "ok": False, "error": f"Unknown command: {cmd}"})
        except Exception as exc:
            emit({
                "id": req_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc()[-600:],
            })


if __name__ == "__main__":
    main()
