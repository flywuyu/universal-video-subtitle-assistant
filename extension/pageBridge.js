// Observe only media metadata requests made by the site's own player. Keep a
// bounded in-memory copy; never read cookies, request headers, or API keys.
(() => {
  if(window.__VSA_NETWORK__) return;
  const cache={entries:[]};
  Object.defineProperty(window,"__VSA_NETWORK__",{value:cache,configurable:true});
  const currentId=()=>{
    const u=new URL(location.href);
    return u.searchParams.get("v") || u.searchParams.get("modal_id") ||
      u.pathname.match(/\/(?:video|shorts|embed|live)\/([\w-]+)/)?.[1] || "";
  };
  const currentCid=()=>{
    const data=window.__INITIAL_STATE__?.videoData;
    const part=Number(new URL(location.href).searchParams.get("p") || "1");
    return data?.pages?.[part-1]?.cid || data?.cid || "";
  };
  const relevant=value=>/youtubei\/v1\/(?:player|next|get_transcript)|api\/timedtext|(?:aisubtitle\.hdslb|subtitle\.bilibili)\.com|api\.bilibili\.com\/x\/(?:player|v2\/subtitle)|aweme\/v\d+\/web\/(?:aweme|feed)|api\/(?:item\/detail|recommend\/item_list)/i.test(value);
  const rememberText=(url,raw,videoId,cid)=>{
    if(!raw || raw.length>2_000_000) return;
    if(/timedtext/.test(url)) {try {videoId=new URL(url,location.href).searchParams.get("v") || videoId;} catch (_) {}}
    cache.entries.push({kind:/timedtext/.test(url) ? "youtube-captions" : "bilibili-captions",videoId,cid,url,value:{raw},at:Date.now()});
    cache.entries=cache.entries.slice(-12);
  };
  const remember=(url,payload,videoId)=>{
    if(!payload || typeof payload!=="object") return;
    let value=null,kind="";
    if(/youtubei\/v1\/player/.test(url)) {
      kind="youtube-player";
      value={videoDetails:payload.videoDetails,captions:payload.captions,playabilityStatus:payload.playabilityStatus,
        streamingData:{adaptiveFormats:(payload.streamingData?.adaptiveFormats || []).filter(item=>item.mimeType?.startsWith("audio/") && item.url)}};
      videoId=payload.videoDetails?.videoId || videoId;
    } else if(/youtubei\/v1\/get_transcript/.test(url)) {
      kind="youtube-transcript";
      value={actions:payload.actions,engagementPanels:payload.engagementPanels,continuationContents:payload.continuationContents};
    } else if(/youtubei\/v1\/next/.test(url)) {
      kind="youtube-next";
      value={engagementPanels:payload.engagementPanels,currentVideoEndpoint:payload.currentVideoEndpoint};
      videoId=payload.currentVideoEndpoint?.watchEndpoint?.videoId || videoId;
    } else if(/bilibili\.com/.test(url)) {
      kind="bilibili-player";
      const data=payload.data || {};
      const u=new URL(url,location.href);
      value={data:{subtitle:data.subtitle,dash:{audio:data.dash?.audio},durl:data.durl},
        cid:u.searchParams.get("cid"),aid:u.searchParams.get("aid"),bvid:u.searchParams.get("bvid")};
    } else {
      kind="short-video";
      const items=[],seen=new WeakSet();
      const walk=(node,depth=0)=>{
        if(!node || typeof node!=="object" || depth>12 || seen.has(node) || items.length>=12) return;
        seen.add(node);
        const id=node.aweme_id || node.id;
        if(id && node.video) {
          items.push({aweme_id:String(id),desc:node.desc || node.title || "",video:node.video,
            interaction_stickers:node.interaction_stickers});
          return;
        }
        for(const child of Object.values(node)) if(child && typeof child==="object") walk(child,depth+1);
      };
      walk(payload);value={items};
    }
    if(!value || JSON.stringify(value).length>2_000_000) return;
    cache.entries.push({kind,videoId,url,value,at:Date.now()});
    cache.entries=cache.entries.slice(-12);
  };
  const originalFetch=window.fetch;
  window.fetch=function(input,init) {
    const url=typeof input==="string" ? input : input?.url || "";
    const videoId=currentId(),cid=currentCid();
    const promise=originalFetch.apply(this,arguments);
    if(relevant(url)) promise.then(response=>{
      if(response.ok && /timedtext|(?:aisubtitle\.hdslb|subtitle\.bilibili)\.com/.test(url))
        response.clone().text().then(value=>rememberText(url,value,videoId,cid)).catch(()=>{});
      else if(response.ok && response.headers.get("content-type")?.includes("json"))
        response.clone().json().then(value=>remember(url,value,videoId)).catch(()=>{});
    }).catch(()=>{});
    return promise;
  };
  const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(method,url) {this.__vsa_url=String(url);return open.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function() {
    const url=this.__vsa_url,videoId=currentId(),cid=currentCid();
    if(url && relevant(url)) this.addEventListener("load",()=>{
      try {
        if(this.status>=200 && this.status<300) {
          if(/timedtext|(?:aisubtitle\.hdslb|subtitle\.bilibili)\.com/.test(url))
            rememberText(url,this.responseText,videoId,cid);
          else {
            const payload=this.responseType==="json" ? this.response : JSON.parse(this.responseText);
            remember(url,payload,videoId);
          }
        }
      } catch (_) {}
    },{once:true});
    return send.apply(this,arguments);
  };
})();
