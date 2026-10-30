"""Local speech service: automatic startup, small model, incremental audio."""
from __future__ import annotations

import ipaddress
import json
import os
import queue
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
from fast_engine import ENGINE, MODEL_NAME, decode_clip, stream_pcm

HOST, PORT = "127.0.0.1", int(os.environ.get("SUBTITLE_PORT", "8765"))
VERSION = "0.3.0"
EXTENSION_ORIGIN = "chrome-extension://ioakbhlnnjbcmcndpgllclgjpjnohaoc"
JOBS, STOP_EVENTS, LIVE_QUEUES, PROCESSES = {}, {}, {}, {}
JOBS_LOCK = threading.RLock()
WORK = queue.Queue()


def valid_video_url(value):
    try:
        u = urlparse(value)
        if u.scheme not in ("https", "http") or not u.hostname or u.username or u.password:
            return False
        host = u.hostname.lower().rstrip(".")
        if host == "localhost" or host.endswith((".localhost", ".local")):
            return False
        try:
            return ipaddress.ip_address(host).is_global
        except ValueError:
            return True
    except (ValueError, TypeError):
        return False


def valid_bili_audio_url(value):
    if not valid_video_url(value):
        return False
    host = (urlparse(value).hostname or "").lower()
    return any(host == item or host.endswith("." + item)
               for item in ("bilivideo.com", "hdslb.com", "bilivideo.cn"))


def update(job_id, **fields):
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(fields, updated_at=time.time())


def add_rows(job_id, rows, offset, language):
    with JOBS_LOCK:
        job = JOBS[job_id]
        for row in rows:
            job["segments"].append({"start": round(offset + row["start"], 3),
                                    "end": round(offset + row["end"], 3), "text": row["text"]})
        if rows and not job.get("first_result_ms"):
            job["first_result_ms"] = round((time.time() - job["created_at"]) * 1000)
        job.update(language=language or "", updated_at=time.time())


def recognize_part(job_id,samples,offset):
    """Publish a small first draft while a cold quality model is still needed."""
    job=JOBS[job_id]
    draft=(job['model']=='turbo' and ENGINE.model_name!='turbo' and not job['segments'])
    if draft:
        update(job_id,quality_phase='draft',phase='先显示语音草稿，随后自动校正')
        rows,language,_=ENGINE.recognize(samples,model_name='tiny')
        add_rows(job_id,rows,offset,language)
        update(job_id,phase='已显示首段草稿，正在载入高质量模型校正')
    rows,language,elapsed=ENGINE.recognize(samples,model_name=job['model'])
    if draft:
        with JOBS_LOCK:
            JOBS[job_id]['segments']=[]
    update(job_id,quality_phase='final')
    add_rows(job_id,rows,offset,language)
    return rows,language,elapsed


def discover_source(url):
    import yt_dlp
    options = {"format": "bestaudio/best", "noplaylist": True, "quiet": True,
               "no_warnings": True, "socket_timeout": 8, "retries": 0,
               "extractor_retries": 0, "skip_download": True}
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)
    selected = info
    formats = info.get("requested_formats") or info.get("requested_downloads") or []
    if formats:
        selected = next((item for item in formats if item.get("vcodec") == "none"), formats[0])
    source = selected.get("url")
    if not source or not valid_video_url(source):
        raise RuntimeError("网站未提供可直接读取的音轨")
    return source, selected.get("http_headers") or info.get("http_headers") or {}, info.get("duration") or 0


def run_job(job_id, stop):
    with JOBS_LOCK:
        job = dict(JOBS[job_id])
    update(job_id, status="running", phase="正在读取音轨，先识别开头 8 秒")
    produced = False
    try:
        source = job.get("audio_url")
        original=urlparse(job["url"])
        headers={"Referer":f"{original.scheme}://{original.netloc}/"} if source else {}
        duration = job.get("duration_hint") or 0
        if not source:
            update(job_id, phase="正在查找可直接读取的音轨")
            source, headers, duration = discover_source(job["url"])
        update(job_id, duration=duration)
        language = None

        def remember(process):
            with JOBS_LOCK:
                if process is None:
                    PROCESSES.pop(job_id, None)
                else:
                    PROCESSES[job_id] = process
            if process is not None and stop.is_set():
                process.kill()

        for samples, offset in stream_pcm(source, headers, stop, remember):
            if stop.is_set():
                raise RuntimeError("已取消")
            update(job_id, phase="快速识别中；新文字会持续出现")
            rows, language, elapsed = recognize_part(job_id,samples,offset)
            produced = produced or bool(rows)
            end = offset + len(samples) / 16000
            update(job_id, processed_seconds=round(end, 2), device=ENGINE.device,
                   progress=min(99, round(end / duration * 100)) if duration else 0,
                   last_inference_ms=round(elapsed * 1000))
        if stop.is_set():
            raise RuntimeError("已取消")
        if not produced:
            raise RuntimeError("没有识别到人声；请确认视频有声音")
        update(job_id, status="done", phase="快速转写完成", progress=100)
    except Exception as exc:
        update(job_id, status="cancelled" if stop.is_set() else "error",
               phase="已取消" if stop.is_set() else "音轨不可直接读取",
               error="已取消" if stop.is_set() else str(exc)[:220],
               needs_playback=not stop.is_set() and not produced)
    finally:
        with JOBS_LOCK:
            STOP_EVENTS.pop(job_id, None)
            PROCESSES.pop(job_id, None)


def worker():
    while True:
        job_id = WORK.get()
        try:
            stop = STOP_EVENTS.get(job_id)
            if stop is not None:
                run_job(job_id, stop)
        finally:
            WORK.task_done()


def run_live_job(job_id, chunks, stop):
    try:
        index, language = 0, None
        with tempfile.TemporaryDirectory(prefix="subtitle_clip_") as temporary:
            while not stop.is_set():
                try:
                    item = chunks.get(timeout=90)
                except queue.Empty:
                    raise RuntimeError("浏览器停止发送声音，请重新点击“播放声音识别”")
                if item is None:
                    chunks.task_done()
                    break
                data, offset = item
                index += 1
                path = Path(temporary) / f"{index}.webm"
                path.write_bytes(data)
                update(job_id, phase="正在快速识别刚播放的声音")
                samples = decode_clip(path)
                rows, language, elapsed = recognize_part(job_id,samples,offset)
                if stop.is_set():
                    raise RuntimeError("已取消")
                update(job_id, phase="继续播放即可；约每 6–10 秒补充文字", device=ENGINE.device,
                       last_inference_ms=round(elapsed * 1000))
                path.unlink(missing_ok=True)
                chunks.task_done()
        with JOBS_LOCK:
            count = len(JOBS[job_id]["segments"])
        update(job_id, status="cancelled" if stop.is_set() else "done" if count else "error",
               phase="录制结束", progress=100,
               error="" if count else "没有识别到人声，请确认视频正在播放且有声音")
    except Exception as exc:
        update(job_id, status="cancelled" if stop.is_set() else "error", error=str(exc)[:220])
    finally:
        STOP_EVENTS.pop(job_id, None)
        LIVE_QUEUES.pop(job_id, None)


def new_job(url, mode, audio_url="", duration=0,profile="balanced"):
    job_id = uuid.uuid4().hex
    JOBS[job_id] = dict(id=job_id, url=url, mode=mode, audio_url=audio_url,
                        duration_hint=duration, duration=duration, status="queued", phase="准备快速识别",
                        progress=0, language="", segments=[], error="", created_at=time.time(),
                        updated_at=time.time(),first_result_ms=0,profile=profile,model="tiny" if profile=="fast" else "turbo")
    STOP_EVENTS[job_id] = threading.Event()
    return job_id


class Handler(BaseHTTPRequestHandler):
    server_version = "VideoSubtitleAssistant/0.3"

    def log_message(self, fmt, *args):
        print(time.strftime("%H:%M:%S"), fmt % args, flush=True)

    def allowed_origin(self):
        origin = self.headers.get("Origin")
        return origin if origin == EXTENSION_ORIGIN else None if origin is None else ""

    def reply(self, code, data):
        encoded = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        try:
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_OPTIONS(self):
        self.reply(403 if self.allowed_origin() == "" else 200, {"ok": self.allowed_origin() != ""})

    def do_GET(self):
        if self.allowed_origin() == "":
            return self.reply(403, {"error": "只接受已安装字幕插件的请求"})
        path = urlparse(self.path).path
        if path == "/health":
            with JOBS_LOCK:
                active = sum(item["status"] in ("queued", "running") for item in JOBS.values())
            return self.reply(200, {"ok": True, "app": "video-subtitle-assistant", "version": VERSION,
                                    "model": MODEL_NAME, "ready": ENGINE.ready.is_set(),
                                    "device": ENGINE.device or "loading", "error": ENGINE.error,
                                    "active_jobs": active})
        if path.startswith("/tracks"):
            return self.reply(200, {"tracks": []})  # Never spend seconds on a redundant downloader probe.
        if path.startswith("/jobs/"):
            with JOBS_LOCK:
                item = JOBS.get(path.split("/")[2])
                snapshot = {k: v for k, v in item.items() if k not in ("audio_url",)} if item else None
                snapshot = json.loads(json.dumps(snapshot))
            return self.reply(200 if snapshot else 404, snapshot or {"error": "任务不存在"})
        return self.reply(404, {"error": "接口不存在"})

    def do_POST(self):
        if self.allowed_origin() == "":
            return self.reply(403, {"error": "只接受已安装字幕插件的请求"})
        parsed = urlparse(self.path)
        path = parsed.path
        if path=="/native":
            try:
                length=int(self.headers.get("Content-Length","0"))
                if not 2<=length<=5000:raise ValueError("请求格式不正确")
                data=json.loads(self.rfile.read(length))
                if not valid_video_url(data.get("url","")):raise ValueError("视频地址无效")
                from native_sources import native_transcript
                return self.reply(200,native_transcript(data["url"],data.get("language","auto")))
            except Exception:
                return self.reply(502,{"error":"本机字幕备用通道暂不可用","blocked":True})
        if path.startswith("/live/") and path.endswith("/chunk"):
            job_id = path.split("/")[2]
            chunks = LIVE_QUEUES.get(job_id)
            if chunks is None:
                return self.reply(404, {"error": "录制任务已结束"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                offset = float(parse_qs(parsed.query).get("start", [0])[0])
                if not 100 <= length <= 10 * 1024**2 or not 0 <= offset < 86400:
                    raise ValueError("录制片段大小或时间不正确")
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("录制片段传输中断")
                chunks.put_nowait((data, offset))
            except (ValueError, queue.Full) as exc:
                return self.reply(429, {"error": str(exc) or "声音识别暂时跟不上，请稍后重试"})
            return self.reply(202, {"ok": True})
        if path.startswith("/live/") and path.endswith("/stop"):
            job_id = path.split("/")[2]
            chunks = LIVE_QUEUES.get(job_id)
            if chunks is not None:
                try:
                    chunks.put_nowait(None)
                except queue.Full:
                    return self.reply(429, {"error": "正在处理录制声音"})
            return self.reply(200, {"ok": True})
        if path.startswith("/jobs/") and path.endswith("/cancel"):
            job_id = path.split("/")[2]
            stop = STOP_EVENTS.get(job_id)
            if stop:
                stop.set()
                process = PROCESSES.get(job_id)
                if process and process.poll() is None:
                    process.kill()
                chunks = LIVE_QUEUES.get(job_id)
                if chunks is not None:
                    try:
                        chunks.put_nowait(None)
                    except queue.Full:
                        pass
            return self.reply(200, {"ok": True})
        if path not in ("/jobs", "/live"):
            return self.reply(404, {"error": "接口不存在"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 2 <= length <= 16384 or not self.headers.get("Content-Type", "").startswith("application/json"):
                raise ValueError("请求格式不正确")
            data = json.loads(self.rfile.read(length))
            url, audio_url = str(data.get("url") or ""), str(data.get("audio_url") or "")
            if not valid_video_url(url) or (audio_url and not valid_video_url(audio_url)):
                raise ValueError("视频地址或音轨地址无效")
            duration = float(data.get("duration") or 0)
            profile="fast" if data.get("profile")=="fast" else "balanced"
            if not 0 <= duration < 86400:
                raise ValueError("视频时长无效")
        except (ValueError, TypeError) as exc:
            return self.reply(400, {"error": str(exc)})
        if profile=="fast":ENGINE.warmup("tiny")
        with JOBS_LOCK:
            if path == "/jobs":
                for item in JOBS.values():
                    if item["url"] == url and item["mode"] == "file" and item.get("profile")==profile and item["status"] in ("queued", "running", "done"):
                        return self.reply(200, {"id": item["id"], "reused": True})
            job_id = new_job(url,"live" if path=="/live" else "file",audio_url,duration,profile)
        if path == "/live":
            chunks = LIVE_QUEUES[job_id] = queue.Queue(maxsize=12)
            update(job_id, status="running", phase="等待播放声音；首段约 6 秒后识别")
            threading.Thread(target=run_live_job, args=(job_id, chunks, STOP_EVENTS[job_id]), daemon=True).start()
        else:
            WORK.put(job_id)
        self.reply(202, {"id": job_id, "reused": False})


def main():
    if "--background" in sys.argv:
        logs = Path(__file__).resolve().parent / "logs"
        logs.mkdir(exist_ok=True)
        sys.stdout = sys.stderr = (logs / "service.log").open("a", encoding="utf-8", buffering=1)
    try:
        service = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        print("字幕服务已经运行，直接打开插件即可。", flush=True)
        return
    service.daemon_threads = True
    threading.Thread(target=worker, daemon=True, name="audio-worker").start()
    print(f"字幕助手 {VERSION} 已就绪，默认 {MODEL_NAME} 快速识别。", flush=True)
    try:
        service.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        for stop in STOP_EVENTS.values():
            stop.set()
        for process in list(PROCESSES.values()):
            if process.poll() is None:
                process.kill()
        service.server_close()


if __name__ == "__main__":
    main()
