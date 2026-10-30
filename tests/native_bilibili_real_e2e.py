"""User's original 47-minute Bilibili example, real independent captions only."""
import json
from pathlib import Path
import tempfile
import time
from urllib.request import getproxies
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
ID='ioakbhlnnjbcmcndpgllclgjpjnohaoc'
VIDEO='https://www.bilibili.com/video/BV1X6JX6sEYJ/'

def main():
    (ROOT / '成果').mkdir(exist_ok=True)
    proxy=getproxies().get('https')
    with tempfile.TemporaryDirectory(prefix='native_bili_',dir=ROOT/'tests') as folder:
        with sync_playwright() as p:
            context=p.chromium.launch_persistent_context(folder,channel='chromium',headless=True,
                proxy={'server':proxy,'bypass':'127.0.0.1,localhost'} if proxy else None,
                args=[f'--disable-extensions-except={ROOT/"extension"}',f'--load-extension={ROOT/"extension"}','--mute-audio'])
            try:
                worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                worker.evaluate('async()=>chrome.storage.local.set({vsa_settings_v3:{autoAsr:false,preferredLanguage:"zh"}})')
                video=context.new_page();response=video.goto(VIDEO,wait_until='domcontentloaded',timeout=35000)
                assert response.status==200
                video.wait_for_timeout(2000)
                panel=context.new_page();video.bring_to_front();started=time.perf_counter()
                panel.goto(f'chrome-extension://{ID}/sidepanel.html')
                try:panel.locator('#status').filter(has_text='完整平台字幕已就绪').wait_for(timeout=30000)
                except Exception:
                    print('Native Bilibili status:',panel.locator('#status').inner_text(),flush=True);raise
                first=round(time.perf_counter()-started,3)
                assert panel.locator('#source-badge').get_attribute('data-quality')=='native'
                assert not panel.locator('#progress-wrap').is_visible()
                with panel.expect_download() as info:panel.locator('#srt-btn').click()
                content=Path(info.value.path()).read_text(encoding='utf-8-sig')
                count=content.count(' --> ')
                assert count>500,count
                assert '投资' in content or '产业' in content,content[:300]
                source=panel.locator('#source-badge').inner_text()
                started=time.perf_counter();panel.reload()
                panel.locator('#status').filter(has_text='已显示缓存的完整平台字幕').wait_for(timeout=10000)
                cached=round(time.perf_counter()-started,3)
                result={'video':VIDEO,'source':source,'quality':'native','first_full_seconds':first,
                    'cached_full_seconds':cached,'segments':count,'srt_export':True,'preview':content[:600]}
                (ROOT/'tests/latest_native_bilibili_real.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
                (ROOT/'成果/对话孙宇晨_平台原字幕.srt').write_text(content,encoding='utf-8-sig')
                print(json.dumps(result,ensure_ascii=False),flush=True)
            finally:context.close()

if __name__=='__main__':main()
