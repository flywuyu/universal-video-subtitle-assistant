"""Native-caption UI test. Speech is covered by real_speech_smoke / browser_real_e2e."""
import json
from pathlib import Path
import shutil
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]


def main():
    with tempfile.TemporaryDirectory(prefix="browser_smoke_",dir=ROOT / "tests") as temporary:
        temp=Path(temporary).resolve()
        assert ROOT.resolve() in temp.parents
        fixture=temp / "fixture"
        fixture.mkdir()
        (fixture / "video.html").write_text('<meta charset="utf-8"><h1>测试视频</h1>'
            '<video><track kind="subtitles" label="中文" src="/captions.vtt"></video>',encoding="utf-8")
        (fixture / "captions.vtt").write_text('WEBVTT\n\n00:01.000 --> 00:02.000\n第一条字幕\n\n'
            '00:03.000 --> 00:04.000\n第二条字幕\n',encoding="utf-8")
        ext=temp / "extension"
        shutil.copytree(ROOT / "extension",ext)
        manifest=json.loads((ext / "manifest.json").read_text(encoding="utf-8"))
        manifest["host_permissions"].append("http://127.0.0.1/*")
        (ext / "manifest.json").write_text(json.dumps(manifest,ensure_ascii=False),encoding="utf-8")
        handler=lambda *args,**kwargs:SimpleHTTPRequestHandler(*args,directory=str(fixture),**kwargs)
        server=ThreadingHTTPServer(("127.0.0.1",0),handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            with sync_playwright() as playwright:
                context=playwright.chromium.launch_persistent_context(str(temp / "profile"),channel="chromium",
                    headless=True,args=[f"--disable-extensions-except={ext}",f"--load-extension={ext}"])
                try:
                    worker=context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
                    video=context.new_page()
                    video.goto(f"http://127.0.0.1:{server.server_port}/video.html")
                    panel=context.new_page()
                    panel.goto(f"chrome-extension://{worker.url.split('/')[2]}/sidepanel.html")
                    video.bring_to_front()
                    panel.reload()
                    panel.locator(".segment-text").get_by_text("第二条字幕").wait_for(timeout=10000)
                    assert not panel.locator("#progress-wrap").is_visible()
                    print("Native captions visible; idle progress is hidden")
                finally:
                    context.close()
        finally:
            server.shutdown()


if __name__=="__main__":
    main()
