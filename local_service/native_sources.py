"""Existing-caption fallback only. Never downloads or transcribes video audio."""
import threading
import time
from urllib.parse import parse_qs, urlparse
from urllib.request import getproxies

CACHE={}
LOCK=threading.Lock()


def native_transcript(url,language="auto"):
    key=(url,language)
    with LOCK:
        cached=CACHE.get(key)
        if cached and cached[0]>time.monotonic()-3600:
            return cached[1]
    parsed=urlparse(url)
    if parsed.hostname not in ("www.youtube.com","youtube.com","m.youtube.com","youtu.be"):
        return {"tracks":[],"blocked":False}
    video_id=parse_qs(parsed.query).get("v",[""])[0]
    if not video_id:
        video_id=parsed.path.rstrip("/").split("/")[-1]
    if len(video_id)!=11:
        raise ValueError("YouTube 视频编号无效")
    import requests
    from youtube_transcript_api import YouTubeTranscriptApi

    class BoundedSession(requests.Session):
        def request(self,*args,**kwargs):
            kwargs.setdefault("timeout",7)
            return super().request(*args,**kwargs)

    try:
        with BoundedSession() as session:
            session.proxies.update(getproxies())
            api=YouTubeTranscriptApi(http_client=session)
            tracks=list(api.list(video_id))
            if not tracks:return {"tracks":[],"blocked":False}
            tracks.sort(key=lambda item:(language!="auto" and not item.language_code.startswith(language),item.is_generated))
            chosen=tracks[0]
            fetched=chosen.fetch()
            result={"tracks":[{"label":chosen.language,"language":chosen.language_code,
                "kind":"平台自动字幕" if chosen.is_generated else "平台字幕",
                "segments":[{"start":row.start,"end":row.start+row.duration,"text":row.text} for row in fetched],
                "format":"segments"}],"blocked":False}
        with LOCK:CACHE[key]=(time.monotonic(),result)
        return result
    except Exception as error:
        name=type(error).__name__
        if name in ("TranscriptsDisabled","NoTranscriptFound"):
            return {"tracks":[],"blocked":False,"code":"NO_NATIVE"}
        return {"tracks":[],"blocked":True,"code":name,
                "error":"YouTube 限制了这条网络连接的字幕读取，可配置 Supadata 使用与 Digest 相同的服务。"}
