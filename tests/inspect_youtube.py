"""Inspect native subtitle availability without credentials or private browser profiles."""
import json
from pathlib import Path
from urllib.request import getproxies
from playwright.sync_api import sync_playwright

VIDEO = "https://www.youtube.com/watch?v=71ya_JC_IbM"


def main():
    proxy=getproxies().get("https")
    with sync_playwright() as p:
        browser=p.chromium.launch(channel="chromium",headless=True,
            proxy={"server":proxy,"bypass":"127.0.0.1,localhost"} if proxy else None,args=["--mute-audio"])
        page=browser.new_page()
        try:
            response=page.goto(VIDEO,wait_until="domcontentloaded",timeout=30000)
            page.wait_for_timeout(1800)
            data=page.evaluate('''async()=>{
                const response=document.querySelector('#movie_player')?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
                const tracks=response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
                const found=[];const walk=(v,d=0)=>{if(!v || typeof v!=='object'||d>30)return;for(const [k,x] of Object.entries(v)){if(k==='getTranscriptEndpoint')found.push(x);if(x&&typeof x==='object')walk(x,d+1);}};
                walk(window.ytInitialData);
                let transcript=null;
                if(found[0]?.params){try{
                  const r=await fetch('/youtubei/v1/get_transcript?prettyPrint=false',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({context:window.ytcfg.get('INNERTUBE_CONTEXT'),params:found[0].params})});
                  const json=await r.json();
                  const rows=[];const read=(v,d=0)=>{if(!v||typeof v!=='object'||d>35)return;for(const[k,x]of Object.entries(v)){if(k==='transcriptSegmentRenderer')rows.push(x);if(x&&typeof x==='object')read(x,d+1);}};read(json);
                  transcript={status:r.status,rows:rows.length,first:rows[0],last:rows.at(-1),keys:Object.keys(json),error:json.error};
                }catch(e){transcript={error:e.message};}}
                let probe=null;
                if(tracks[0]){try{const u=new URL(tracks[0].baseUrl);u.searchParams.set('fmt','json3');const r=await fetch(u);const t=await r.text();probe={status:r.status,bytes:t.length,preview:t.slice(0,100)};}catch(e){probe={error:e.message};}}
                return {title:document.title,playerId:response?.videoDetails?.videoId,playability:response?.playabilityStatus?.status,
                  tracks:tracks.map(t=>({lang:t.languageCode,name:t.name,kind:t.kind,tokenRequired:t.baseUrl.includes('exp=xpe')})),
                  transcriptEndpoints:found,probe,transcript,context:!!window.ytcfg?.get?.('INNERTUBE_CONTEXT')};
            }''')
            result={"http":response.status,**data}
            Path("tests/latest_youtube_probe.json").write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding="utf-8")
            print(json.dumps(result,ensure_ascii=False),flush=True)
        finally:
            browser.close()


if __name__=="__main__": main()
