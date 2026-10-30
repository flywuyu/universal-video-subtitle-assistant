"""Real Douyin page -> current media -> local Turbo -> export. No transcript fixture."""
import json
from pathlib import Path
import tempfile
import time
from urllib.request import Request,build_opener,ProxyHandler,getproxies
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
ID='ioakbhlnnjbcmcndpgllclgjpjnohaoc'
VIDEO='https://www.douyin.com/video/7689305777282415962'
OPENER=build_opener(ProxyHandler({}))

def local(path,data=None):
    request=Request('http://127.0.0.1:8765'+path,data=json.dumps(data).encode() if data is not None else None,
        headers={'Content-Type':'application/json'})
    with OPENER.open(request,timeout=5) as response:return json.load(response)

def main():
    (ROOT / '成果').mkdir(exist_ok=True)
    proxy=getproxies().get('https')
    with tempfile.TemporaryDirectory(prefix='douyin_e2e_',dir=ROOT/'tests') as folder:
        with sync_playwright() as p:
            context=p.chromium.launch_persistent_context(folder,channel='chromium',headless=True,
                proxy={'server':proxy,'bypass':'127.0.0.1,localhost'} if proxy else None,
                args=[f'--disable-extensions-except={ROOT/"extension"}',f'--load-extension={ROOT/"extension"}','--mute-audio'])
            try:
                worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                worker.evaluate('async()=>chrome.storage.local.set({vsa_settings_v3:{autoAsr:false}})')
                video=context.new_page();response=video.goto(VIDEO,wait_until='domcontentloaded',timeout=35000)
                assert response.status==200
                video.wait_for_function('''()=>window.__VSA_NETWORK__?.entries?.some(entry=>entry.value?.items?.some(item=>item.aweme_id==='7689305777282415962'))''',timeout=25000)
                panel=context.new_page();panel.goto(f'chrome-extension://{ID}/sidepanel.html')
                video.bring_to_front();panel.reload()
                panel.locator('#status').filter(has_text='没有取得独立字幕').wait_for(timeout=15000)
                started=time.perf_counter();panel.locator('#asr-btn').click()
                panel.locator('.segment-text').first.wait_for(timeout=60000)
                first=round(time.perf_counter()-started,3)
                print('Real Douyin first visible seconds:',first,flush=True)
                try:panel.locator('#status').filter(has_text='转写完成').wait_for(timeout=180000)
                except Exception:
                    print(panel.locator('#status').inner_text(),flush=True);raise
                job_id=local('/jobs',{'url':VIDEO})['id'];job=local('/jobs/'+job_id)
                with panel.expect_download() as info:panel.locator('#srt-btn').click()
                content=Path(info.value.path()).read_text(encoding='utf-8-sig')
                assert len(job['segments'])>5
                assert content.count(' --> ')==len(job['segments'])
                assert job['duration']>100 and job['segments'][-1]['end']>100,job
                result={'url':VIDEO,'source':'real audio ASR; no independent subtitle returned','model':job['model'],
                    'first_visible_seconds':first,'server_first_seconds':job['first_result_ms']/1000,
                    'total_seconds':round(job['updated_at']-job['created_at'],3),'duration':job['duration'],
                    'segments':len(job['segments']),'export':True,'preview':job['segments'][:5]}
                (ROOT/'tests/latest_douyin_real.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
                (ROOT/'成果/抖音_AI说明书_高质量字幕.srt').write_text(content,encoding='utf-8-sig')
                panel.set_viewport_size({'width':530,'height':1100})
                panel.screenshot(path=str(ROOT/'tests/latest_douyin_real.png'),full_page=True)
                print(json.dumps(result,ensure_ascii=False),flush=True)
            finally:context.close()

if __name__=='__main__':main()
