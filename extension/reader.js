import {parseSubtitle,normalizeSegments} from "./transcript.js";
import {supadataSupports} from "./settings.js";

export async function readTrack(track,fetchInPage) {
  let rows=track.segments || [];
  if(!rows.length) {
    let raw=track.raw;
    if(!raw) {
      const variants=[track.url];
      if(track.format==="youtube") {
        const url=new URL(track.url);url.searchParams.set("fmt","json3");
        variants.unshift(url.href);
      }
      let lastError;
      for(const url of [...new Set(variants)]) {
        const control=new AbortController(),timer=setTimeout(()=>control.abort(),2500);
        try {
          try {
            const response=await fetch(url,{credentials:"include",signal:control.signal});
            if(!response.ok) throw new Error(`HTTP ${response.status}`);
            raw=await response.text();
          } catch (_) {raw=await fetchInPage(url);}
          rows=parseSubtitle(raw);
          if(rows.length) break;
          lastError=new Error("网站返回了空字幕");
        } catch(error) {lastError=error;}
        finally {clearTimeout(timer);}
      }
      if(!rows.length && lastError) throw lastError;
    } else rows=parseSubtitle(raw);
  }
  rows=normalizeSegments(rows);
  if(!rows.length) throw new Error("字幕轨暂时无法读取");
  return {segments:rows,source:`${track.kind} · ${track.label}`,quality:"native",language:track.language || ""};
}

export async function readNative({pagePromise,cloudPromise,fetchInPage,forcePage,localNative,preferredLanguage="auto"}) {
  const pageTask=(async()=>{
    const page=await pagePromise;
    const rank=track=>(preferredLanguage!=="auto" && !String(track.language || "").replace(/^ai[-_]/i,"").startsWith(preferredLanguage) ? 10 : 0)+
      (track.kind==="平台自动字幕" ? 1 : 0);
    const tracks=[...(page.tracks || [])].sort((a,b)=>rank(a)-rank(b));
    const errors=[];
    for(const track of tracks.slice(0,3)) {
      try {return {...await readTrack(track,fetchInPage),page};}
      catch(error) {errors.push(error);}
    }
    if(page.site==="YouTube") {
      const forced=await forcePage();
      for(const track of forced.tracks || []) if(track.segments?.length || track.raw) {
        try {return {...await readTrack(track,fetchInPage),page:forced};} catch(error) {errors.push(error);}
      }
      if(!cloudPromise && localNative) {
        try {
          const fallback=await localNative(page.url);
          for(const track of fallback.tracks || []) return {...await readTrack(track,fetchInPage),page};
        } catch (_) {}
      }
    }
    const error=new Error(errors[0]?.message || "页面没有返回可直接读取的字幕");
    error.code=page.nativeStatus==="blocked" || tracks.length ? "NATIVE_BLOCKED" : "NO_PAGE_NATIVE";
    error.page=page;
    throw error;
  })();
  try {return await Promise.any([pageTask,...(cloudPromise ? [cloudPromise] : [])]);}
  catch(error) {
    const errors=error.errors || [error];
    const page=(await pagePromise.catch(()=>null)) || {};
    const providerError=errors.find(item=>item.code && !["NATIVE_BLOCKED","NO_PAGE_NATIVE","NO_NATIVE_TRANSCRIPT"].includes(item.code));
    const blocked=errors.some(item=>item.code==="NATIVE_BLOCKED");
    const noNative=errors.some(item=>item.code==="NO_NATIVE_TRANSCRIPT");
    return {segments:[],page,quality:"none",blocked:!!providerError || (!noNative && blocked),
      error:providerError?.message || errors[0]?.message || "未取得字幕",code:providerError?.code || (blocked ? "NATIVE_BLOCKED" : "NO_NATIVE"),
      needsSupadata:blocked && supadataSupports(page.url || "https://example.com") && !cloudPromise};
  }
}
