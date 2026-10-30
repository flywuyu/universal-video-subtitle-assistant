"""Real extension -> native startup -> real HTTP audio -> real model -> visible text."""
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import build_opener, ProxyHandler

import psutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = "ioakbhlnnjbcmcndpgllclgjpjnohaoc"
OPENER = build_opener(ProxyHandler({}))


def health():
    try:
        with OPENER.open("http://127.0.0.1:8765/health", timeout=1) as response:
            return json.load(response)
    except Exception:
        return None


def stop_idle_project_service():
    data = health()
    if data and data.get("active_jobs", 0):
        raise RuntimeError("A user transcription is active; cold-start test must wait")
    target = (ROOT / "local_service/server.py").resolve()
    for process in psutil.process_iter(["name", "cmdline"]):
        if process.info["name"].lower() not in ("python.exe", "pythonw.exe"):
            continue
        if any(Path(arg).is_absolute() and Path(arg).resolve() == target
               for arg in (process.info.get("cmdline") or [])[1:] if not arg.startswith("-")):
            process.terminate()
            process.wait(timeout=5)
    assert not health(), "Service did not stop"


def main():
    stop_idle_project_service()
    with tempfile.TemporaryDirectory(prefix="real_e2e_", dir=ROOT / "tests") as temporary:
        temp = Path(temporary).resolve()
        assert ROOT.resolve() in temp.parents
        fixture = temp / "fixture"
        fixture.mkdir()
        (fixture / "video.html").write_text(
            '<meta charset="utf-8"><h1>真实语音识别测试</h1>'
            '<video controls preload="metadata" src="https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/samples/jfk.wav"></video>',
            encoding="utf-8")
        ext = temp / "extension"
        shutil.copytree(ROOT / "extension", ext)
        manifest = json.loads((ext / "manifest.json").read_text(encoding="utf-8"))
        manifest["host_permissions"].append("http://subtitle-test.invalid/*")
        (ext / "manifest.json").write_text(json.dumps(manifest,ensure_ascii=False),encoding="utf-8")
        handler = lambda *args, **kwargs: SimpleHTTPRequestHandler(*args, directory=str(fixture), **kwargs)
        fixture_server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=fixture_server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(str(temp / "profile"),
                    channel="chromium", headless=True, args=[f"--disable-extensions-except={ext}",
                    f"--load-extension={ext}","--host-resolver-rules=MAP subtitle-test.invalid 127.0.0.1","--no-proxy-server"])
                try:
                    worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
                    assert worker.url.split("/")[2] == EXTENSION
                    video = context.new_page()
                    video.goto(f"http://subtitle-test.invalid:{fixture_server.server_port}/video.html",wait_until="domcontentloaded")
                    panel = context.new_page()
                    video.bring_to_front()
                    started = time.perf_counter()
                    panel.goto(f"chrome-extension://{EXTENSION}/sidepanel.html")
                    panel.locator(".segment-text").filter(has_text="Americans").first.wait_for(timeout=60000)
                    first_seconds = round(time.perf_counter()-started, 3)
                    text = panel.locator("#segments").inner_text()
                    assert "country" in text.lower(), text
                    panel.locator('#status').filter(has_text='转写完成').wait_for(timeout=120000)
                    result = {"cold_start_to_visible_text_seconds":first_seconds,
                              "full_quality_complete_seconds":round(time.perf_counter()-started,3),
                              "visible_text":panel.locator('#segments').inner_text(),"health":health()}
                    (ROOT / "tests/latest_real_browser.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
                    print(json.dumps(result,ensure_ascii=False),flush=True)
                finally:
                    context.close()
            assert health(), "Service vanished after native host/browser exited"
        finally:
            fixture_server.shutdown()


if __name__ == "__main__":
    main()
