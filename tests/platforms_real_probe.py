"""Read-only real public page probes. No private profiles, keys or fake captions."""
import json
from pathlib import Path
import tempfile
import time
from urllib.request import getproxies
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
VIDEOS=["https://www.youtube.com/watch?v=71ya_JC_IbM",
        "https://www.douyin.com/video/7689305777282415962",
        "https://www.bilibili.com/video/BV19shU6uEzM/",
        "https://www.bilibili.com/video/BV1X6JX6sEYJ/"]

def main():
    source=(ROOT/'extension/pageProbe.js').read_text(encoding='utf-8')
    probe=source.split('export async function probePage',1)[1].split('export async function fetchTrackInPage',1)[0]
    probe='async function '+probe
    proxy=getproxies().get('https')
    results=[]
    with tempfile.TemporaryDirectory(prefix='platform_probe_',dir=ROOT/'tests') as folder:
        with sync_playwright() as p:
            context=p.chromium.launch_persistent_context(folder,channel='chromium',headless=True,
                proxy={'server':proxy,'bypass':'127.0.0.1,localhost'} if proxy else None,
                args=[f'--disable-extensions-except={ROOT / "extension"}',f'--load-extension={ROOT / "extension"}','--mute-audio'])
            try:
                worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                await_settings="async()=>chrome.storage.local.set({vsa_settings_v3:{autoAsr:false}})"
                worker.evaluate(await_settings)
                for url in VIDEOS:
                    page=context.new_page()
                    try:
                        response=page.goto(url,wait_until='domcontentloaded',timeout=35000)
                        page.wait_for_timeout(10000 if 'douyin' in url else 2500)
                        started=time.perf_counter()
                        data=page.evaluate('('+probe+')',{})
                        result={'url':url,'http':response.status,'title':data.get('title'),'site':data.get('site'),
                            'probe_seconds':round(time.perf_counter()-started,3),'native_status':data['nativeStatus'],
                            'tracks':len(data['tracks']),'has_audio':bool(data.get('audioUrl')),'duration':data.get('duration'),
                            'diagnostics':data.get('diagnostics')}
                        if data['site']=='抖音':
                            result['metadata']=page.evaluate('''()=>({title:document.title,
                              state:!!window._ROUTER_DATA,render:!!document.querySelector('#RENDER_DATA'),
                              observed:window.__VSA_NETWORK__?.entries?.map(v=>({kind:v.kind,items:v.value?.items?.map(x=>({id:x.aweme_id,videoKeys:Object.keys(x.video||{})}))})),
                              renderPreview:document.querySelector('#RENDER_DATA')?.textContent?.slice(0,300),
                              rootKeys:Object.keys(window._ROUTER_DATA || {}),
                              text:document.body.innerText.slice(0,350)})''')
                        print(json.dumps(result,ensure_ascii=False),flush=True)
                        results.append(result)
                    except Exception as error:
                        results.append({'url':url,'error':str(error)[:300]})
                        print(json.dumps(results[-1],ensure_ascii=False),flush=True)
                    finally:page.close()
            finally:context.close()
    (ROOT/'tests/latest_platforms_real.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':main()
