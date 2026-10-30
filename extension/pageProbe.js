// Serialized into the player's MAIN world. Every helper stays inside this function.
export async function probePage(options={}) {
  const request = async (url, type="json", init={}) => {
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 1800);
    try {
      const response = await fetch(url, {credentials:"include",...init,signal:control.signal});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return type === "bytes" ? new Uint8Array(await response.arrayBuffer()) : await response.json();
    } finally {clearTimeout(timer);}
  };
  const video = document.querySelector("video");
  const result = {url:location.href,title:document.querySelector("h1")?.textContent?.trim() || document.title,
    site:location.hostname.includes("bilibili.com") ? "Bilibili" : location.hostname.includes("youtube.com") ? "YouTube" :
      /(^|\.)(?:douyin|iesdouyin)\.com$/.test(location.hostname) ? "抖音" : location.hostname.includes("tiktok.com") ? "TikTok" : location.hostname,
    duration:Number.isFinite(video?.duration) ? video.duration : 0, tracks:[],diagnostics:[],nativeStatus:"unknown"};
  const network=window.__VSA_NETWORK__?.entries || [];
  const textOf=value=>typeof value==="string" ? value : value?.simpleText || value?.content ||
    value?.runs?.map(item=>item.text || "").join("") || "";
  const collect=(root,key)=>{
    const found=[],stack=[root],seen=new WeakSet();let count=0;
    while(stack.length && count++<20000) {
      const item=stack.pop();if(!item || typeof item!=="object" || seen.has(item)) continue;
      seen.add(item);
      for(const [name,value] of Object.entries(item)) {
        if(name===key) found.push(value);
        if(value && typeof value==="object") stack.push(value);
      }
    }
    return found;
  };
  const transcriptRows=root=>{
    const rows=[];
    for(const kind of ["transcriptSegmentRenderer","transcriptSegmentViewModel"])
      for(const item of collect(root,kind)) {
        const start=Number(item.startMs ?? item.startTimeMs);
        const end=Number(item.endMs ?? item.endTimeMs ?? start+1000);
        const text=textOf(item.snippet || item.text || item.transcript);
        if(Number.isFinite(start) && text) rows.push({start:start/1000,end:Math.max(start,end)/1000,text});
      }
    return rows.sort((a,b)=>a.start-b.start);
  };
  // Address transform used by the public Bilibili web player's F/U helpers
  // (core.0a5e425c.js). The query already contains the platform's signed expiry.
  const subtitleAddress=raw=>{
    const match=String(raw).match(/^(?:https?:)?\/\/subtitle\.bilibili\.com\/([^?]+)(\?.*)?$/);
    if(!match) return raw;
    const pairs=[['nP](wOFRvU.+<fjS{jn-!$D|Dz&",zT`',"=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`"],
      ['Bn"q~|albg@]Go~ACgyDvKnd+)_D}^&J?',"Cu~L!xs~f^&r@'vh=q]q{eeng*sEg^kp#J"]];
    try {
      const encoded=decodeURIComponent(match[1]);
      for(const [prefix,base] of pairs) {
        const key=base+"bilibili";
        const plain=Array.from(encoded,(char,i)=>String.fromCharCode(char.charCodeAt(0)^key.charCodeAt(i%key.length))).join("");
        if(plain.startsWith(prefix)) {
          const path=plain.slice(prefix.length);
          if(path.startsWith("/bfs/") && !/[\x00-\x20]/.test(path)) return "https://aisubtitle.hdslb.com"+path+(match[2] || "");
        }
      }
    } catch (_) {}
    result.diagnostics.push("平台字幕地址格式已变化，请刷新页面后重试");
    return "";
  };
  const addTrack = entry => {
    const raw = subtitleAddress(entry.subtitle_url || entry.url || "");
    if (!raw) return;
    const url = new URL(raw, location.origin).href;
    if (!/^https?:/.test(url) || result.tracks.some(track => track.url === url)) return;
    result.tracks.push({label:entry.lan_doc || entry.lan || "字幕",language:entry.lan || "",
      kind:entry.ai_type || /^ai[-_]/i.test(entry.lan || "") ? "平台自动字幕" : "平台字幕",url,format:"bcc"});
  };
  const readProto = bytes => {
    const fields = [];
    let position = 0;
    const integer = () => {
      let value=0,shift=0;
      for(let i=0;i<10;i++) {
        if(position>=bytes.length) throw new Error("短字幕响应");
        const b=bytes[position++]; value+=(b&127)*2**shift;
        if(!(b&128)) return value;
        shift+=7;
      }
      throw new Error("字幕响应格式错误");
    };
    while(position<bytes.length) {
      const tag=integer(),wire=tag&7,field=Math.floor(tag/8);
      if(wire===2) {
        const length=integer();
        if(length<0 || position+length>bytes.length) throw new Error("字幕响应长度错误");
        fields.push({field,data:bytes.slice(position,position+length)}); position+=length;
      } else if(wire===0) {integer();}
      else if(wire===1) position+=8;
      else if(wire===5) position+=4;
      else throw new Error("字幕响应类型错误");
    }
    return fields;
  };

  if(result.site==="Bilibili") {
    const bvid=location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1];
    let initial=window.__INITIAL_STATE__?.videoData;
    if(initial?.bvid!==bvid) initial=null;
    if(!initial && /^BV[0-9A-Za-z]{10}$/.test(bvid || "")) {
      try {
        const meta=await request(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
        if(meta?.data?.bvid===bvid) initial=meta.data;
      } catch (_) {}
    }
    const part=Number(new URLSearchParams(location.search).get("p") || "1");
    const cid=initial?.pages?.[part-1]?.cid || initial?.cid;
    const aid=initial?.aid;
    result.bvid=bvid || ""; result.cid=cid || 0; result.aid=aid || 0;
    result.duration=result.duration || initial?.pages?.[part-1]?.duration || initial?.duration || 0;
    const matched=!!initial && String(initial.cid)===String(cid);
    if(matched) for(const entry of initial.subtitle?.list || []) addTrack(entry);
    for(const entry of network.filter(item=>item.kind==="bilibili-captions" && item.videoId===bvid && String(item.cid)===String(cid)))
      result.tracks.unshift({label:"播放器当前字幕",language:"",kind:"平台字幕",raw:entry.value.raw,format:"bcc"});
    for(const entry of network.filter(item=>item.kind==="bilibili-player" && String(item.value?.cid)===String(cid)))
      for(const track of entry.value?.data?.subtitle?.subtitles || []) addTrack(track);
    const resources=performance.getEntriesByType("resource").map(item=>item.name).reverse();
    const readCaptions=async()=>{
      if(result.tracks.length || !cid || !aid) return;
      const signed=resources.find(value=>{
        try {
          const u=new URL(value);
          return u.hostname==="api.bilibili.com" && u.pathname.includes("/x/player/wbi/v2") &&
            u.searchParams.get("cid")===String(cid) &&
            (!u.searchParams.get("aid") || u.searchParams.get("aid")===String(aid)) &&
            (!u.searchParams.get("bvid") || u.searchParams.get("bvid")===bvid);
        } catch (_) {return false;}
      });
      if(signed) {
        try {const data=await request(signed); for(const entry of data?.data?.subtitle?.subtitles || []) addTrack(entry);} catch (_) {}
      }
      if(!result.tracks.length) {
        try {
          const params=new URLSearchParams({oid:String(cid),pid:String(aid),type:"1",context_ext:'{"video_type":1}',cur_production_type:"0"});
          const bytes=await request(`https://api.bilibili.com/x/v2/subtitle/web/view?${params}`,"bytes");
          if(bytes[0]===123) {
            const json=JSON.parse(new TextDecoder().decode(bytes));
            for(const entry of json?.data?.subtitles || json?.data?.subtitle?.subtitles || []) addTrack(entry);
          } else {
            for(const top of readProto(bytes).filter(item=>item.field===1)) {
              for(const track of readProto(top.data).filter(item=>item.field===3)) {
                const entry={};
                for(const item of readProto(track.data)) {
                  const key={3:"lan",4:"lan_doc",5:"subtitle_url"}[item.field];
                  if(key) entry[key]=new TextDecoder().decode(item.data);
                }
                addTrack(entry);
              }
            }
          }
        } catch (_) {}
      }
    };
    const readAudio=async()=>{
      const choose=data=>{
        const entries=data?.dash?.audio;
        if(entries?.length) {
          const entry=[...entries].sort((a,b)=>(a.bandwidth||0)-(b.bandwidth||0))[0];
          return entry.baseUrl || entry.base_url || "";
        }
        return data?.durl?.[0]?.url || "";
      };
      if(matched) result.audioUrl=choose(window.__playinfo__?.data || window.__playinfo__);
      if(!result.audioUrl && cid) {
        result.audioUrl=resources.find(value=>{
          try {
            const u=new URL(value);
            return /(^|\.)bilivideo\.(com|cn)$/.test(u.hostname) &&
              (u.pathname.includes(`/${cid}/`) || u.pathname.includes(`${cid}-`)) &&
              (/302\d+\.m4s/.test(u.pathname) || /audio/i.test(u.searchParams.get("mime_type") || ""));
          } catch (_) {return false;}
        }) || "";
      }
      if(!result.audioUrl && cid && bvid) {
        try {
          const params=new URLSearchParams({bvid,cid:String(cid),qn:"16",fnval:"16",fnver:"0",fourk:"0"});
          const data=await request(`https://api.bilibili.com/x/player/playurl?${params}`);
          result.audioUrl=choose(data?.data);
        } catch (_) {}
      }
    };
    await Promise.allSettled([readCaptions(),readAudio()]);
    if(!result.tracks.length) result.diagnostics.push("未读到独立字幕轨");
    result.nativeStatus=result.tracks.length ? "available" : initial ? "absent" : "unknown";
  }
  if(result.site==="YouTube") {
    const expected=new URLSearchParams(location.search).get("v") || location.pathname.match(/\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
    result.videoId=expected;
    for(const entry of network.filter(item=>item.kind==="youtube-captions" && item.videoId===expected))
      result.tracks.unshift({label:"播放器当前字幕",language:"",kind:"平台字幕",raw:entry.value.raw,format:"youtube-native"});
    const element=document.querySelector("#movie_player");
    let current=null;
    try {current=element?.getPlayerResponse?.();if(typeof current==="string") current=JSON.parse(current);} catch (_) {}
    const candidates=[current,window.ytInitialPlayerResponse,...network.filter(item=>item.kind==="youtube-player" && item.videoId===expected).map(item=>item.value)];
    const player=candidates.find(item=>item?.videoDetails?.videoId===expected);
    if(player) {
      result.title=player.videoDetails.title || result.title;
      result.duration=result.duration || Number(player.videoDetails.lengthSeconds) || 0;
      for(const entry of player.captions?.playerCaptionsTracklistRenderer?.captionTracks || []) {
        result.tracks.push({label:entry.name?.simpleText || entry.name?.runs?.map(x=>x.text).join("") || entry.languageCode,
          language:entry.languageCode || "",kind:entry.kind==="asr" ? "平台自动字幕" : "平台字幕",url:entry.baseUrl,format:"youtube"});
      }
      const audio=(player.streamingData?.adaptiveFormats || []).filter(item=>item.url && item.mimeType?.startsWith("audio/"))
        .sort((a,b)=>(a.bitrate||0)-(b.bitrate||0))[0];
      if(audio) result.audioUrl=audio.url;
    }
    const timed=performance.getEntriesByType("resource").map(item=>item.name).reverse().find(value=>{
      try {const u=new URL(value);return u.hostname.endsWith("youtube.com") && u.pathname.includes("timedtext") && u.searchParams.get("v")===expected;} catch (_) {return false;}
    });
    if(timed) result.tracks.unshift({label:"播放器当前字幕",language:new URL(timed).searchParams.get("lang") || "",
      kind:"平台字幕",url:timed,format:"youtube"});
    const nextRoots=[window.ytInitialData,...network.filter(item=>item.kind==="youtube-next" && item.videoId===expected).map(item=>item.value)];
    const params=nextRoots.flatMap(root=>collect(root,"getTranscriptEndpoint")).map(item=>item.params).filter(value=>{
      try {return atob(decodeURIComponent(value).replace(/-/g,"+").replace(/_/g,"/")).includes(expected);} catch (_) {return false;}
    });
    const addTranscript=rows=>{
      if(!rows.length) return false;
      result.tracks.unshift({label:"完整转写文稿",language:"",kind:"平台字幕",segments:rows,format:"segments"});
      return true;
    };
    const captured=network.filter(item=>item.kind==="youtube-transcript" && item.videoId===expected).reverse();
    for(const item of captured) if(addTranscript(transcriptRows(item.value))) break;
    if((!result.tracks.length || options.forceTranscript) && params.length) {
      try {
        const context=window.ytcfg?.get?.("INNERTUBE_CONTEXT");
        if(context) {
          const headers={"Content-Type":"application/json"};
          const client=window.ytcfg.get("INNERTUBE_CONTEXT_CLIENT_NAME"),version=window.ytcfg.get("INNERTUBE_CLIENT_VERSION");
          if(client) headers["X-Youtube-Client-Name"]=String(client);
          if(version) headers["X-Youtube-Client-Version"]=String(version);
          const payload=await request("/youtubei/v1/get_transcript?prettyPrint=false","json",{
            method:"POST",headers,body:JSON.stringify({context,params:params[0]})});
          addTranscript(transcriptRows(payload));
        }
      } catch (_) {result.diagnostics.push("YouTube 限制了直接字幕请求");}
    }
    if(options.forceTranscript && !result.tracks.some(track=>track.segments?.length)) {
      const buttons=[...(document.querySelectorAll?.("button,[role=button]") || [])];
      const button=buttons.find(item=>/^(show transcript|显示(?:转写|转录|文字)文稿|显示文字记录)$/i.test(item.textContent?.trim() || ""));
      if(button) {
        button.click();
        for(let attempt=0;attempt<4;attempt++) {
          await new Promise(resolve=>setTimeout(resolve,400));
          const records=(window.__VSA_NETWORK__?.entries || []).filter(item=>item.kind==="youtube-transcript" && item.videoId===expected).reverse();
          if(records.some(item=>addTranscript(transcriptRows(item.value)))) break;
          const nodes=[...(document.querySelectorAll?.("ytd-transcript-segment-renderer") || [])];
          const rows=nodes.map(node=>{
            const stamp=node.querySelector(".segment-timestamp")?.textContent?.trim();
            const start=stamp?.split(":").reduce((sum,v)=>sum*60+Number(v),0);
            return {start,end:start+3,text:node.querySelector(".segment-text")?.textContent?.trim() || ""};
          }).filter(row=>Number.isFinite(row.start) && row.text);
          if(rows.length>10 && (!result.duration || rows.at(-1).start>result.duration*.7) && addTranscript(rows)) break;
        }
      }
    }
    result.nativeStatus=result.tracks.length ? "available" : params.length || !player || current?.playabilityStatus?.status==="LOGIN_REQUIRED" ? "blocked" : "absent";
    if(result.nativeStatus==="blocked") result.diagnostics.push("字幕读取受网站限制，可使用与 Digest 相同的 Supadata 原生字幕通道");
  }
  if(result.site==="抖音" || result.site==="TikTok") {
    const id=location.pathname.match(/\/(?:video|share\/video)\/(\d+)/)?.[1] || new URLSearchParams(location.search).get("modal_id");
    result.videoId=id || "";
    const roots=[window._ROUTER_DATA,window.__INITIAL_STATE__,window.__NEXT_DATA__,window.SIGI_STATE,
      ...network.filter(item=>item.kind==="short-video").map(item=>item.value)];
    for(const name of ["RENDER_DATA","__UNIVERSAL_DATA_FOR_REHYDRATION__","SIGI_STATE"]) {
      const raw=document.querySelector(`#${name}`)?.textContent;
      if(raw) {try {roots.push(JSON.parse(raw));} catch (_) {try {roots.push(JSON.parse(decodeURIComponent(raw)));} catch (_) {}}}
    }
    let matched=null;
    const walk=(item,depth=0)=>{
      if(matched || !item || typeof item!=="object" || depth>18) return;
      if(item.video && String(item.aweme_id || item.id)===id) {matched=item;return;}
      for(const value of Object.values(item)) if(value && typeof value==="object") walk(value,depth+1);
    };
    if(id) for(const root of roots) walk(root);
    if(matched) {
      const media=matched.video;
      result.title=matched.desc || matched.title || result.title;
      result.duration=Number(media.duration || 0)/(result.site==="抖音" ? 1000 : 1) || result.duration;
      const captions=[...(media.cla_info?.caption_infos || []),...(media.subtitleInfos || []),...(media.subtitle_infos || []),
        ...(matched.interaction_stickers || []).flatMap(item=>item.auto_video_caption_info?.auto_captions || [])];
      for(const track of captions) {
        const url=track.url?.url_list?.[0] || track.url_list?.[0] || track.Url || (typeof track.url==="string" ? track.url : "");
        if(url) result.tracks.push({label:track.LanguageCodeName || track.lang || track.language || "原字幕",
          language:track.lang || track.language || "",kind:"平台字幕",url:new URL(url,location.origin).href,format:track.Format || "auto"});
      }
      result.audioUrl=media.audio?.play_addr?.url_list?.[0] || media.play_addr?.url_list?.[0] || media.playAddr?.urlList?.[0] ||
        media.playAddr?.[0]?.src || (typeof media.playAddr==="string" ? media.playAddr : "") || "";
      result.nativeStatus=result.tracks.length ? "available" : "absent";
    } else result.nativeStatus="blocked";
  }
  if(video) {
    for(const item of video.querySelectorAll("track")) {
      try {if(item.track.mode==="disabled") item.track.mode="hidden";} catch (_) {}
      const segments=item.track?.cues ? [...item.track.cues].map(cue=>({start:cue.startTime,end:cue.endTime,text:cue.text})) : [];
      if(segments.length || item.src) result.tracks.push({label:item.label || item.srclang || "网页字幕",language:item.srclang || "",
        kind:"网页字幕",url:item.src || "",segments,format:"vtt"});
    }
    if(!result.audioUrl && /^https?:/.test(video.currentSrc || "")) result.audioUrl=video.currentSrc;
  }
  if(result.tracks.length) result.nativeStatus="available";
  return result;
}

export async function fetchTrackInPage(url) {
  const control=new AbortController();
  const timer=setTimeout(()=>control.abort(),3000);
  try {
    const response=await fetch(url,{credentials:"include",signal:control.signal});
    if(!response.ok) throw new Error(`字幕请求失败：${response.status}`);
    return await response.text();
  } finally {clearTimeout(timer);}
}

// Kept self-contained because this runs in the player's MAIN world.
export function controlVideo(action="position",seconds=0) {
  const videos=[...document.querySelectorAll("video")];
  const score=video=>{
    const rect=video.getBoundingClientRect();
    const visible=rect.width>0 && rect.height>0 && rect.bottom>0 && rect.top<innerHeight;
    return (visible ? rect.width*rect.height : 0)+(!video.paused && visible ? 1e8 : 0);
  };
  const video=videos.sort((a,b)=>score(b)-score(a))[0];
  if(!video) return 0;
  if(action==="seek") {video.currentTime=seconds;video.play().catch(()=>{});}
  return video.currentTime || 0;
}
