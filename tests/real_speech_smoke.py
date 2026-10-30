"""Real HTTP + real speech model smoke test, without a fake transcript service."""
import json
from pathlib import Path
import time
from urllib.request import Request, build_opener, ProxyHandler

ROOT = Path(__file__).resolve().parents[1]
OPENER = build_opener(ProxyHandler({}))
ORIGIN = "chrome-extension://ioakbhlnnjbcmcndpgllclgjpjnohaoc"


def call(path, data=None, content_type="application/json"):
    headers = {"Origin": ORIGIN}
    if data is not None:
        headers["Content-Type"] = content_type
        if not isinstance(data, bytes):
            data = json.dumps(data).encode()
    with OPENER.open(Request("http://127.0.0.1:8765"+path, data=data, headers=headers), timeout=30) as response:
        return json.load(response)


def main():
    health = call("/health")
    results = []
    for language in ("zh", "en"):
        clip = ROOT / "tests" / "fixtures" / f"speech_{language}.wav"
        started = time.perf_counter()
        job_id = call("/live", {"url":"https://example.com/test-speech"})["id"]
        call(f"/live/{job_id}/chunk?start=120", clip.read_bytes(), "audio/wav")
        call(f"/live/{job_id}/stop", b"")
        first = None
        for _ in range(1200):
            job = call(f"/jobs/{job_id}")
            if job["segments"] and first is None:
                first = round(time.perf_counter()-started, 3)
            if job["status"] in ("done", "error", "cancelled"):
                break
            time.sleep(0.1)
        assert job["status"] == "done", job
        assert job["segments"] and job["segments"][0]["start"] >= 120, job
        result = {"language":language, "first_result_seconds":first,
                  "completion_seconds":round(time.perf_counter()-started,3),"model":job.get('model'),
                  "inference_ms":job.get("last_inference_ms"),
                  "device":job.get("device"), "text":" ".join(x["text"] for x in job["segments"])}
        print(json.dumps(result, ensure_ascii=False))
        results.append(result)
    (ROOT / "tests" / "latest_real_speech.json").write_text(
        json.dumps({"health":health,"results":results},ensure_ascii=False,indent=2),encoding="utf-8")


if __name__ == "__main__":
    main()
