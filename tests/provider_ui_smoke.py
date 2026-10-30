"""Browser UI contract test with explicitly simulated external provider responses.

This is NOT a live Supadata/DeepSeek account or latency test.
"""
import json
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
ID='ioakbhlnnjbcmcndpgllclgjpjnohaoc'
VIDEO='https://www.youtube.com/watch?v=71ya_JC_IbM'

def main():
    with tempfile.TemporaryDirectory(prefix='provider_ui_',dir=ROOT/'tests') as folder:
        with sync_playwright() as p:
            context=p.chromium.launch_persistent_context(folder,channel='chromium',headless=True,
                args=[f'--disable-extensions-except={ROOT/"extension"}',f'--load-extension={ROOT/"extension"}'])
            try:
                worker=context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
                worker.evaluate('''()=>{const real=fetch;globalThis.__contractCalls=[];globalThis.fetch=async(url,init)=>{
                  if(String(url).startsWith('https://api.supadata.ai/')) {
                    __contractCalls.push({provider:'supadata',mode:new URL(url).searchParams.get('mode')});
                    return Response.json({content:[{offset:0,duration:3000,text:'Welcome to the world of esports.'},
                      {offset:9000,duration:2500,text:'Players became creators.'}],lang:'en'});
                  }
                  if(String(url).startsWith('https://api.deepseek.com/')) {
                    const body=JSON.parse(init.body);__contractCalls.push({provider:'deepseek',model:body.model});
                    const input=JSON.parse(body.messages[1].content);
                    const text=input.segments ? JSON.stringify({segments:input.segments.map(row=>({id:row.id,text:'中文字幕 '+row.id}))}) : '00:00 视频介绍电竞历史。';
                    return Response.json({choices:[{message:{content:text}}]});
                  }
                  return real(url,init);
                }}''')
                options=context.new_page()
                options.goto(f'chrome-extension://{ID}/options.html')
                options.locator('#supadata-key').fill('contract-test-only')
                options.locator('#deepseek-key').fill('contract-ai-only')
                options.locator('#auto-asr').uncheck()
                options.get_by_role('button',name='保存设置').click()
                options.get_by_text('设置已保存',exact=False).wait_for()
                options.reload()
                assert options.locator('#supadata-key').input_value()=='contract-test-only'
                assert options.locator('#supadata-key').get_attribute('type')=='password'
                context.route('https://www.youtube.com/**',lambda route:route.fulfill(status=200,
                    content_type='text/html',body='<title>Provider contract fixture</title><h1>Fixture video</h1><video></video>'))
                video=context.new_page();video.goto(VIDEO)
                panel=context.new_page();panel.goto(f'chrome-extension://{ID}/sidepanel.html')
                video.bring_to_front();panel.reload()
                panel.locator('.segment-text').filter(has_text='Welcome to the world of esports.').wait_for(timeout=10000)
                assert 'Supadata' in panel.locator('#source-badge').inner_text()
                assert panel.locator('#source-badge').get_attribute('data-quality')=='native'
                assert not panel.locator('#progress-wrap').is_visible()
                assert 'contract-test-only' not in panel.locator('body').inner_text()
                panel.locator('[data-view=bilingual]').click()
                panel.locator('.segment-text').filter(has_text='中文字幕 0').wait_for(timeout=10000)
                panel.locator('.note-save').first.click()
                panel.locator('[data-panel=notes]').click()
                panel.locator('#notes-list').get_by_text('Welcome to the world of esports.',exact=True).wait_for()
                panel.locator('[data-panel=overview]').click()
                panel.locator('#overview-btn').click()
                panel.locator('#overview-content').get_by_text('00:00 视频介绍电竞历史。',exact=True).wait_for()
                panel.locator('[data-panel=transcript]').click()
                with panel.expect_download() as download:
                    panel.locator('#srt-btn').click()
                content=Path(download.value.path()).read_text(encoding='utf-8-sig')
                assert content.count(' --> ')==2
                assert '中文字幕 0' in content and 'Welcome to the world of esports.' in content
                calls=worker.evaluate('()=>__contractCalls')
                assert calls[0]['mode']=='native'
                result={'type':'simulated external API contract, not live account','native_source':True,'settings_persisted':True,
                    'translation':True,'notes':True,'overview':True,'srt_export':True,'calls':calls}
                (ROOT/'tests/latest_provider_ui_contract.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
                print(json.dumps(result,ensure_ascii=False),flush=True)
                panel.set_viewport_size({'width':530,'height':1100})
                panel.screenshot(path=str(ROOT/'tests/latest_provider_ui_contract.png'),full_page=True)
            finally:context.close()

if __name__=='__main__':main()
