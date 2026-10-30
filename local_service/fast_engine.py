"""Small cached speech model and incremental FFmpeg audio decoding."""
from __future__ import annotations

import gc
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import getproxies, proxy_bypass

import numpy as np

SAMPLE_RATE = 16000
MODEL_NAME = os.environ.get("SUBTITLE_MODEL", "turbo")
FIRST_SECONDS = 8
CHUNK_SECONDS = 30


def external_transcription_active():
    try:
        import psutil
        for process in psutil.process_iter(["pid", "cmdline"]):
            if process.info["pid"] == os.getpid():
                continue
            command = " ".join(process.info.get("cmdline") or [])
            if any(name in command for name in ("transcribe_one.py", "_one_off_transcribe.py")):
                return True
    except Exception:
        pass
    return False


class SpeechEngine:
    def __init__(self):
        self.lock = threading.RLock()
        self.model = None
        self.model_name = ""
        self.device = ""
        self.ready = threading.Event()
        self.loading = False
        self.error = ""
        self.loaded_seconds = 0.0

    def warmup(self,model_name=None):
        model_name=model_name or MODEL_NAME
        if (self.model is not None and self.model_name==model_name) or self.loading:
            return
        with self.lock:
            if (self.model is not None and self.model_name==model_name) or self.loading:
                return
            self.loading = True
        threading.Thread(target=self._warm,args=(model_name,),daemon=True,name="speech-warmup").start()

    def _warm(self,model_name):
        try:
            model, device = self.get(model_name)
            import av  # Load the audio decoder before the first browser chunk arrives.
            with self.lock:
                model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language="en",
                                 task="transcribe", fp16=device=="cuda", temperature=0.0,
                                 beam_size=1, condition_on_previous_text=False, verbose=None)
        except Exception as exc:
            self.error = str(exc)
        finally:
            self.loading = False

    def get(self,model_name=None):
        model_name=model_name or MODEL_NAME
        with self.lock:
            if self.model is not None and self.model_name==model_name:
                return self.model, self.device
            started = time.perf_counter()
            self.ready.clear()
            import torch
            import whisper
            if self.model is not None:
                self.model=None
                gc.collect()
                if torch.cuda.is_available():torch.cuda.empty_cache()
            torch.set_num_threads(min(4, os.cpu_count() or 1))
            device = "cpu"
            if os.environ.get("SUBTITLE_DEVICE") != "cpu" and not external_transcription_active():
                try:
                    if torch.cuda.is_available() and torch.cuda.mem_get_info()[0] > 800 * 1024**2:
                        device = "cuda"
                except Exception:
                    pass
            try:
                model = whisper.load_model(model_name, device=device)
                if device == "cuda":
                    model.half()
                    from whisper.model import LayerNorm
                    for layer in model.modules():
                        if isinstance(layer, LayerNorm):
                            layer.float()
            except Exception:
                if device != "cuda":
                    raise
                gc.collect()
                torch.cuda.empty_cache()
                device = "cpu"
                model = whisper.load_model(model_name, device=device)
            self.model, self.device = model, device
            self.model_name=model_name
            self.loaded_seconds = round(time.perf_counter() - started, 3)
            self.error = ""
            self.ready.set()
            return model, device

    def recognize(self, samples, language=None,model_name=None):
        if len(samples) < SAMPLE_RATE // 4:
            return [], language, 0.0
        # Silence is common between speech segments. Skip it instead of inviting
        # the speech model to invent text and spending time on empty audio.
        if float(np.sqrt(np.mean(samples.astype(np.float64) ** 2))) < 0.001:
            return [], language, 0.0
        started = time.perf_counter()
        with self.lock:
            model, device = self.get(model_name)
            options = dict(language=language or None, task="transcribe", fp16=device == "cuda",
                           temperature=0.0, beam_size=1, condition_on_previous_text=False,
                           verbose=None)
            try:
                result = model.transcribe(samples, **options)
            except RuntimeError as exc:
                if device != "cuda" or "memory" not in str(exc).lower():
                    raise
                self.model = None
                self.ready.clear()
                os.environ["SUBTITLE_DEVICE"] = "cpu"
                del model
                import torch
                gc.collect()
                torch.cuda.empty_cache()
                model, device = self.get(model_name)
                options["fp16"] = False
                result = model.transcribe(samples, **options)
        duration = len(samples) / SAMPLE_RATE
        rows = []
        for item in result.get("segments") or []:
            text = str(item.get("text") or "").strip()
            if not text or (item.get("no_speech_prob", 0) > 0.8 and item.get("avg_logprob", 0) < -1):
                continue
            start = max(0.0, min(duration, float(item["start"])))
            end = max(start, min(duration, float(item["end"])))
            rows.append({"start": start, "end": end, "text": text})
        return rows, result.get("language") or language, time.perf_counter() - started


ENGINE = SpeechEngine()


def stream_pcm(source, headers=None, stop=None, process_callback=None):
    """Yield PCM as soon as the first eight seconds arrive, without a full download."""
    import imageio_ffmpeg
    stop = stop or threading.Event()
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error"]
    if str(source).startswith(("https://", "http://")):
        command += ["-rw_timeout", "12000000", "-user_agent", "Mozilla/5.0"]
        host = urlparse(str(source)).hostname or ""
        proxy = getproxies().get(urlparse(str(source)).scheme)
        if proxy and not proxy_bypass(host) and urlparse(proxy).scheme in ("http", "https"):
            command += ["-http_proxy", proxy]
        safe_headers = {k: str(v) for k, v in (headers or {}).items()
                        if k.lower() in ("referer", "origin", "user-agent") and "\n" not in str(v) and "\r" not in str(v)}
        if safe_headers:
            command += ["-headers", "".join(f"{k}: {v}\r\n" for k, v in safe_headers.items())]
    command += ["-i", str(source), "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE),
                "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"]
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if process_callback:
            process_callback(process)
        offset = 0.0
        try:
            size = FIRST_SECONDS * SAMPLE_RATE * 2
            while not stop.is_set():
                data = process.stdout.read(size)
                if not data:
                    break
                usable = len(data) - len(data) % 2
                samples = np.frombuffer(data[:usable], dtype="<i2").astype(np.float32) / 32768.0
                yield samples, offset
                offset += len(samples) / SAMPLE_RATE
                size = CHUNK_SECONDS * SAMPLE_RATE * 2
            if stop.is_set():
                raise RuntimeError("已取消")
            code = process.wait(timeout=5)
            if code:
                errors.seek(0)
                detail = errors.read(1500).decode("utf-8", "replace")
                # Don't expose signed media URLs or account tokens in the UI.
                raise RuntimeError("音轨读取失败：" + next((line for line in reversed(detail.splitlines())
                                                         if line and "http" not in line), "网络或播放地址不可用")[:160])
        finally:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            process.stdout.close()
            if process_callback:
                process_callback(None)


def decode_clip(path):
    import av
    pieces = []
    with av.open(str(Path(path))) as container:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                pieces.append(converted.to_ndarray().reshape(-1))
        for converted in resampler.resample(None):
            pieces.append(converted.to_ndarray().reshape(-1))
    return np.concatenate(pieces).astype(np.float32) / 32768.0 if pieces else np.empty(0,dtype=np.float32)
