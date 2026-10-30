"""Real Bilibili page, production extension, production service, real speech output."""
import json
from pathlib import Path
import tempfile
import time
from urllib.request import Request, build_opener, ProxyHandler, getproxies

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ID = "ioakbhlnnjbcmcndpgllclgjpjnohaoc"
VIDEO = "https://www.bilibili.com/video/BV19shU6uEzM/"
OPENER = build_opener(ProxyHandler({}))


def local(path, data=None):
    request=Request("http://127.0.0.1:8765"+path,data=json.dumps(data).encode() if data is not None else None,
                    headers={"Content-Type":"application/json"})
    with OPENER.open(request,timeout=5) as response:
        return json.load(response)


def main():
    (ROOT / '成果').mkdir(exist_ok=True)
    proxy = getproxies().get("https")
    with tempfile.TemporaryDirectory(prefix="bili_e2e_",dir=ROOT / "tests") as folder:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(folder,channel="chromium",headless=True,
                proxy={"server":proxy,"bypass":"127.0.0.1,localhost"} if proxy else None,
                args=[f"--disable-extensions-except={ROOT / 'extension'}",f"--load-extension={ROOT / 'extension'}","--mute-audio"])
            try:
                worker=context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
                assert worker.url.split("/")[2] == ID
                page=context.new_page()
                response=page.goto(VIDEO,wait_until="domcontentloaded",timeout=25000)
                assert response.status==200,response.status
                page.wait_for_timeout(1200)
                panel=context.new_page()
                panel.goto(f"chrome-extension://{ID}/sidepanel.html")
                page.bring_to_front()
                started=time.perf_counter()
                panel.reload()
                try:
                    panel.locator(".segment-text").first.wait_for(timeout=60000)
                except Exception:
                    print("UI status:",panel.locator("#status").inner_text(),flush=True)
                    raise
                first=round(time.perf_counter()-started,3)
                print("First visible Bilibili transcript",first,panel.locator("#segments").inner_text()[:350],flush=True)
                panel.locator("#status").filter(has_text="转写完成").wait_for(timeout=180000)
                identity=local("/jobs",{"url":VIDEO+'?p=1'})
                job=local("/jobs/"+identity["id"])
                with panel.expect_download() as info:
                    panel.locator("#srt-btn").click()
                content=Path(info.value.path()).read_text(encoding="utf-8-sig")
                assert content.count(" --> ") == len(job["segments"])
                assert job["segments"][-1]["end"] > 1450, job["segments"][-1]
                (ROOT/'成果/央视财经专访马斯克_高质量字幕.srt').write_text(content,encoding='utf-8-sig')
                result={"video":VIDEO,"first_visible_current_open_seconds":first,
                        "server_first_result_seconds":job["first_result_ms"]/1000,
                        "server_total_seconds":round(job["updated_at"]-job["created_at"],3),
                        "duration":job["duration"],"segments":len(job["segments"]),"srt_export":True,
                        "model":job.get('model'),
                        "reused_job":identity.get("reused"),
                        "status":panel.locator("#status").inner_text(),"preview":panel.locator("#segments").inner_text()[:2000]}
                (ROOT / "tests/latest_bilibili_real.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
                print(json.dumps(result,ensure_ascii=False),flush=True)
            finally:
                context.close()


if __name__ == "__main__":
    main()
