import { normalizeSegments, exportText, stamp } from "./transcript.js";
import { probePage, fetchTrackInPage, controlVideo } from "./pageProbe.js";
import { ensureService, serviceRequest } from "./service.js";
import {getSettings,canonicalVideoUrl,supadataSupports} from "./settings.js";
import {readNative,readTrack} from "./reader.js";

const LOCAL = "http://127.0.0.1:8765";
const $ = id => document.getElementById(id);
const state = { tabId:0, url:"", title:"", audioUrl:"", duration:0, tracks:[], segments:[], source:"",quality:"none",jobId:"", poll:null, live:null, shown:250,
  epoch:0,settings:null,view:"original",translations:{},translationRunning:false,overview:"" };

function status(message, error=false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function canonical(url) {
  try {return canonicalVideoUrl(url);} catch (_) {return url;}
}

function cacheKey() { return "transcript:" + canonical(state.url); }

async function cacheCurrent() {
  if (!state.segments.length) return;
  try {
    await chrome.storage.local.set({[cacheKey()]: {
      title:state.title, source:state.source,quality:state.quality,segments:state.segments, saved:Date.now(),
    }});
  } catch (_) { /* The visible transcript still works when browser storage is full. */ }
}

async function loadCache() {
  const cached = (await chrome.storage.local.get(cacheKey()))[cacheKey()];
  if (cached?.segments?.length) {
    state.segments = normalizeSegments(cached.segments);
    state.source = cached.source + " · 缓存";
    state.quality=cached.quality || (/识别|转写|草稿/.test(cached.source) ? "asr" : "native");
    render();
    status(`已显示上次保存的 ${state.segments.length} 条字幕；正在检查当前页面。`);
    return state.quality==="native" && Date.now()-cached.saved<7*86400000;
  }
  return false;
}

function render() {
  $("transcript-area").hidden = !state.segments.length;
  $("source-badge").textContent = state.source;
  $("source-badge").dataset.quality=state.quality;
  $("count").textContent = `${state.segments.length} 条`;
  const query = $("search").value.trim().toLocaleLowerCase();
  const allRows=state.segments.map((row,index)=>({...row,index}));
  const matches = query ? allRows.filter(s => (s.text+" "+(state.translations[s.index] || "")).toLocaleLowerCase().includes(query)) : allRows;
  const visible = matches.slice(0, state.shown);
  const root = $("segments");
  root.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "没有匹配的字幕";
    root.append(empty);
  }
  const fragment = document.createDocumentFragment();
  for (const segment of visible) {
    const row = document.createElement("div"); row.className = "segment";
    const time = document.createElement("button"); time.className = "time";
    time.textContent = stamp(segment.start); time.title = "跳转到此时间";
    time.addEventListener("click", () => seek(segment.start));
    const text = document.createElement("div"); text.className = "segment-text";
    const translated=state.translations[segment.index];
    text.textContent=state.view==="original" ? segment.text : state.view==="bilingual" ? segment.text+"\n"+(translated || "（译文准备中）") : translated || segment.text;
    const bookmark=document.createElement("button");bookmark.className="note-save";bookmark.title="保存这条字幕为笔记";bookmark.textContent="＋笔记";
    bookmark.addEventListener("click",()=>saveNote(segment.text,segment.start));text.append(bookmark);
    row.append(time, text); fragment.append(row);
  }
  root.append(fragment);
  $("more-btn").hidden = matches.length <= state.shown;
  for(const button of document.querySelectorAll("[data-view]")) button.classList.toggle("selected",button.dataset.view===state.view);
  $("translate-all").hidden=state.view==="original";
}

async function activeTab() {
  const tabs = await chrome.tabs.query({active:true,lastFocusedWindow:true});
  return tabs.find(t => /^https?:/.test(t.url || "")) || tabs[0];
}

async function execute(func, args=[],tabId=state.tabId) {
  const [item] = await chrome.scripting.executeScript({
    target:{tabId}, world:"MAIN", func, args,
  });
  return item.result;
}

async function provider(action,body={}) {
  const result=await chrome.runtime.sendMessage({target:"vsa-provider",action,...body});
  if(!result?.ok) {const error=new Error(result?.error || "字幕服务没有响应");error.code=result?.code;throw error;}
  return result;
}

async function readVideo(force=false) {
  const epoch=++state.epoch;
  if (state.live) stopLive();
  if (state.jobId) {
    localRequest(`/jobs/${state.jobId}/cancel`, {method:"POST"}).catch(() => {});
    clearInterval(state.poll);
    state.poll = null;
    state.jobId = "";
    $("progress-wrap").hidden = true;
    $("asr-btn").disabled = false;
  }
  status("正在查看播放器和字幕轨…");
  $("read-btn").disabled = true;
  try {
    const tab = await activeTab();
    if (!tab?.id || !/^https?:/.test(tab.url || "")) throw new Error("请先打开一个网页视频");
    state.tabId = tab.id;
    if (state.url && canonical(state.url) !== canonical(tab.url)) {
      state.segments = [];
      state.source = "";
      $("transcript-area").hidden = true;
    }
    state.url=tab.url;state.title=tab.title || "当前视频";
    state.audioUrl="";state.duration=0;state.tracks=[];
    state.translations={};state.view="original";state.overview="";
    $("overview-content").textContent="";
    $("video-title").textContent=state.title;$("video-url").textContent=state.url;
    const nativeCached=await loadCache();
    if(force) {state.segments=[];state.source="";render();}
    state.settings=await getSettings();
    loadNotes().catch(()=>{});
    if(nativeCached && !force) {status(`已显示缓存的完整平台字幕，共 ${state.segments.length} 条。`);return;}
    const cloudPromise=supadataSupports(state.url) && state.settings.supadataApiKey ?
      provider("nativeTranscript",{url:canonical(state.url)}) : null;
    const pagePromise=execute(probePage,[],tab.id).then(async page=>{
      if(page.site==="Bilibili" && page.cid && !page.tracks?.length) {
        await new Promise(resolve=>setTimeout(resolve,400));
        if(epoch!==state.epoch) return page;
        page=await execute(probePage,[],tab.id);
      }
      if(epoch===state.epoch) {
        state.url=page.url;state.title=page.title;state.audioUrl=page.audioUrl || "";state.duration=page.duration || 0;state.tracks=page.tracks || [];
        $("video-title").textContent=state.title;$("video-url").textContent=state.url;$("site-badge").textContent=page.site;
      }
      return page;
    });
    const result=await readNative({pagePromise,cloudPromise,preferredLanguage:state.settings.preferredLanguage,fetchInPage:url=>execute(fetchTrackInPage,[url],tab.id),
      forcePage:()=>execute(probePage,[{forceTranscript:true}],tab.id),
      localNative:async url=>{await ensureService();return serviceRequest("/native",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({url,language:state.settings.preferredLanguage})},10000);}});
    if(epoch!==state.epoch) return;
    if(result.segments.length) {
      state.segments=result.segments;state.source=result.source;state.quality="native";state.shown=250;
      $("search").value="";render();await cacheCurrent();
      status(`完整平台字幕已就绪，共 ${state.segments.length} 条。`);
      loadTranslations().catch(()=>{});
    }
    if (state.tracks.length && result.segments.length) {
      state.tracks.sort((a,b) => {
        const rank = t => (t.kind === "平台字幕" ? 0 : t.kind === "网页字幕" ? 1 : 2) +
          (/^(zh|en)/i.test(t.language || "") ? -0.2 : 0);
        return rank(a)-rank(b);
      });
      const select = $("track-select"); select.replaceChildren();
      state.tracks.forEach((track,i) => {
        const option = document.createElement("option"); option.value = i;
        option.textContent = `${track.label} · ${track.kind}`;
        select.append(option);
      });
      select.hidden = state.tracks.length < 2;
    } else $("track-select").hidden=true;
    if(!result.segments.length && !state.segments.length) {
      if(result.needsSupadata) {
        status("网页字幕读取受 YouTube 限制。设置中填入 Supadata Key，即可启用与 Digest 相同的原生字幕服务。",true);
      } else if(result.blocked || ["INVALID_SUPADATA_KEY","RATE_LIMITED","PROVIDER_ERROR"].includes(result.code)) {
        status(`${result.error}。可以重试、检查设置，或手动选择语音转写。`,true);
      } else if(state.settings.autoAsr) await startAsr();
      else status("没有取得独立字幕。可点击“从声音生成”使用高质量语音转写。");
    }
  } catch (error) {
    if(epoch===state.epoch) status(error.message || String(error), true);
  } finally {
    if(epoch===state.epoch) $("read-btn").disabled = false;
  }
}

async function chooseTrack(index) {
  const track = state.tracks[index];
  if (!track) return;
  const epoch=++state.epoch;
  if(state.jobId) {
    localRequest(`/jobs/${state.jobId}/cancel`,{method:"POST"}).catch(()=>{});
    clearInterval(state.poll);state.poll=null;state.jobId="";
    $("progress-wrap").hidden=true;$("asr-btn").disabled=false;
  }
  status(`正在读取${track.label}字幕…`);
  try {
    const result=await readTrack(track,url=>execute(fetchTrackInPage,[url]));
    if(epoch!==state.epoch) return;
    state.translations={};state.view="original";
    state.segments=result.segments;state.source=result.source;state.quality="native";
    state.shown = 250;
    $("search").value = "";
    render();
    await cacheCurrent();
    status(`已读取 ${state.segments.length} 条字幕。点击时间可跳转。`);
  } catch (error) {
    if(epoch===state.epoch) status(`${track.label}：${error.message}。可尝试其他轨道或从声音生成。`, true);
  }
}

const localRequest = serviceRequest;

async function startAsr() {
  if (state.live) { status("请先结束正在进行的实时识别。", true); return; }
  if (!state.url) {
    status("正在读取当前视频，稍后会自动开始识别。");
    return;
  }
  $("asr-btn").disabled = true;
  const epoch=state.epoch,url=canonical(state.url),audioUrl=state.audioUrl,duration=state.duration;
  status("正在连接快速识别引擎…");
  try {
    state.settings=await getSettings();
    if(epoch!==state.epoch) return;
    if(state.settings.cloudGeneration && state.settings.supadataApiKey && audioUrl) {
      status("正在使用已启用的云端高质量音频转写…");
      try {
        const result=await provider("nativeTranscript",{url:audioUrl,generate:true});
        if(epoch!==state.epoch) return;
        state.segments=result.segments;state.source=result.source;state.quality="asr";
        render();await cacheCurrent();status(`云端语音转写完成，共 ${state.segments.length} 条。`);
        $("asr-btn").disabled=false;return;
      } catch(error) {status(`云端转写暂不可用，继续使用本机高质量转写：${error.message}`);}
    }
    if(epoch!==state.epoch) return;
    await ensureService();
    if(epoch!==state.epoch) return;
    const reply = await localRequest("/jobs", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({url,audio_url:audioUrl,duration,profile:state.settings.asrProfile}),
    });
    if(epoch!==state.epoch) {localRequest(`/jobs/${reply.id}/cancel`,{method:"POST"}).catch(()=>{});return;}
    state.jobId = reply.id;
    state.segments = [];
    state.quality="asr";state.source=state.settings.asrProfile==="fast" ? "极速语音草稿" : "高质量语音转写";
    $("transcript-area").hidden = true;
    $("progress-wrap").hidden = false;
    $("cancel-btn").textContent = "取消";
    clearInterval(state.poll);
    await pollJob();
    if (state.jobId) state.poll = setInterval(pollJob, 500);
  } catch (error) {
    if(epoch!==state.epoch) return;
    $("progress-wrap").hidden = true;
    status(error.message || "快速识别服务未启动，请运行“安装或修复.bat”。", true);
    $("asr-btn").disabled = false;
  }
}

function startLive() {
  if (!state.url || !state.tabId) {
    status("请先点击“读取本页字幕”，再启动实时识别。", true);
    return;
  }
  if (state.jobId) {
    status("请先结束当前转写任务。", true);
    return;
  }
  // tabCapture must be called immediately after this button click.
  chrome.tabCapture.capture({audio:true,video:false}, async stream => {
    if (!stream) {
      status(chrome.runtime.lastError?.message || "无法捕获当前标签页声音。", true);
      return;
    }
    const live = {stream, recorder:null, timer:null, pending:0, stopping:false,
      stopped:false, audioContext:null, jobId:""};
    state.live = live;
    try {
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      source.connect(context.destination);
      live.audioContext = context;
      await ensureService();
      const reply = await localRequest("/live", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({url:canonical(state.url),profile:(await getSettings()).asrProfile}),
      });
      live.jobId = reply.id;
      state.jobId = reply.id;
      state.segments = [];
      state.quality="asr";state.source = "播放声音语音转写";
      $("progress-wrap").hidden = false;
      $("progress-text").textContent = "实时";
      $("cancel-btn").textContent = "结束录制";
      $("live-btn").disabled = true;
      status("正在识别播放声音。保持侧边栏打开；先收集 6 秒声音，随后持续补充文字。");
      clearInterval(state.poll);
      state.poll = setInterval(pollJob,500);
      stream.getAudioTracks()[0].addEventListener("ended", () => stopLive());
      await nextLiveChunk(live);
    } catch (error) {
      stream.getTracks().forEach(t => t.stop());
      live.audioContext?.close();
      state.live = null;
      $("live-btn").disabled = false;
      status(`实时识别启动失败：${error.message}`, true);
    }
  });
}

async function nextLiveChunk(live) {
  if (live.stopping || state.live !== live) return;
  let offset = 0;
  try { offset = await execute(controlVideo); }
  catch (_) {}
  if (live.stopping || state.live !== live) return;
  const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const recorder = new MediaRecorder(live.stream, {mimeType:type,audioBitsPerSecond:64000});
  live.recorder = recorder;
  const pieces = [];
  recorder.ondataavailable = event => { if (event.data.size) pieces.push(event.data); };
  recorder.onstop = () => {
    clearTimeout(live.timer);
    const blob = new Blob(pieces, {type});
    if (!live.stopping) nextLiveChunk(live).catch(error => {status(error.message,true);stopLive();});
    if (blob.size > 100) {
      live.pending++;
      localRequest(`/live/${live.jobId}/chunk?start=${encodeURIComponent(offset)}`,
        {method:"POST",headers:{"Content-Type":type},body:blob},30000)
        .catch(error => status(`音频片段传送失败：${error.message}`, true))
        .finally(() => {live.pending--; if (live.stopping) finishLive(live);});
    } else if (live.stopping) finishLive(live);
  };
  recorder.start();
  const milliseconds = live.hasRecorded ? 10000 : 6000;
  live.hasRecorded = true;
  live.timer = setTimeout(() => {if (recorder.state === "recording") recorder.stop();},milliseconds);
}

function stopLive() {
  const live = state.live;
  if (!live || live.stopping) return;
  live.stopping = true;
  clearTimeout(live.timer);
  if (live.recorder?.state === "recording") live.recorder.stop();
  else finishLive(live);
  status("正在结束录制并处理最后一段声音…");
}

async function finishLive(live) {
  if (live.stopped || live.pending) return;
  live.stopped = true;
  try { await localRequest(`/live/${live.jobId}/stop`,{method:"POST"}); }
  catch (error) { status(`结束实时识别失败：${error.message}`, true); }
  live.stream.getTracks().forEach(t => t.stop());
  await live.audioContext?.close();
  state.live = null;
  $("live-btn").disabled = false;
}

async function pollJob() {
  if (!state.jobId) return;
  const jobId = state.jobId;
  try {
    const job = await localRequest(`/jobs/${jobId}`, {}, 4000);
    if (jobId !== state.jobId) return;
    const previous = state.segments;
    const previousSource=state.source;
    state.segments = normalizeSegments(job.segments || []);
    state.quality="asr";
    state.source = `${job.model==="tiny" || job.quality_phase==="draft" ? "语音草稿 · 正在自动校正" : "高质量语音转写"}${job.language ? " · "+job.language : ""}`;
    $("progress-bar").style.width = `${job.mode === "live" ? 100 : job.progress || 0}%`;
    $("progress-text").textContent = job.mode === "live" ? "实时" : `${job.progress || 0}%`;
    if (previousSource!==state.source || state.segments.length !== previous.length || state.segments.some((row,i)=>row.text!==previous[i]?.text)) render();
    let estimate = "";
    if (job.mode !== "live" && job.progress >= 3 && job.progress < 99 && job.created_at) {
      const elapsed = Date.now()/1000 - job.created_at;
      const remaining = Math.max(0, Math.round(elapsed * (100-job.progress) / job.progress / 60));
      estimate = ` · 预计约 ${remaining} 分钟`;
    }
    status(`${job.phase} · 已生成 ${state.segments.length} 条${estimate}`);
    if (["done","error","cancelled"].includes(job.status)) {
      if (state.live) {
        const live = state.live;
        live.stopping = true;
        clearTimeout(live.timer);
        live.stream.getTracks().forEach(t => t.stop());
        live.audioContext?.close();
        state.live = null;
      }
      clearInterval(state.poll); state.poll = null;
      state.jobId = "";
      $("progress-wrap").hidden = true;
      $("asr-btn").disabled = false;
      $("live-btn").disabled = false;
      if (job.status === "done") {
        render(); await cacheCurrent(); status(`转写完成，共 ${state.segments.length} 条。`);
      } else {
        const message = job.needs_playback ? "网站暂未提供可直接读取的音轨。点“播放声音识别”，约收集 6 秒声音后开始出字。" :
          job.error || (job.status === "cancelled" ? "已取消" : "转写失败");
        status(message, job.status === "error");
      }
    }
  } catch (error) {
    if (jobId !== state.jobId) return;
    clearInterval(state.poll); state.poll = null;
    state.jobId = "";
    $("progress-wrap").hidden = true;
    $("asr-btn").disabled = false;
    status(`本地服务连接中断：${error.message}`, true);
  }
}

async function cancelAsr() {
  if (state.live) return stopLive();
  if (!state.jobId) return;
  try { await localRequest(`/jobs/${state.jobId}/cancel`, {method:"POST"}); }
  catch (error) { status(error.message, true); }
}

async function seek(seconds) {
  try {
    await execute(controlVideo,["seek",seconds]);
  } catch (_) { status("该页面不允许跳转播放器。", true); }
}

function filename(extension) {
  return `${state.title.replace(/[<>:"/\\|?*\x00-\x1f]/g," ").trim().slice(0,80) || "视频字幕"}.${extension}`;
}

async function download(format) {
  if (!state.segments.length) return;
  const content = exportText(exportRows(), format, state.title);
  const objectUrl = URL.createObjectURL(new Blob(["\uFEFF",content], {type:"text/plain;charset=utf-8"}));
  try {
    await chrome.downloads.download({url:objectUrl,filename:filename(format),saveAs:false});
    status(`已准备导出 ${format.toUpperCase()}。`);
  } finally { setTimeout(() => URL.revokeObjectURL(objectUrl), 60000); }
}

function exportRows() {
  return state.segments.map((row,index)=>({...row,text:state.view==="original" ? row.text :
    state.view==="bilingual" ? row.text+(state.translations[index] ? "\n"+state.translations[index] : "") : state.translations[index] || row.text}));
}

function contentKey(prefix) {
  let hash=2166136261;
  for(const row of state.segments) for(let i=0;i<row.text.length;i++) hash=Math.imul(hash ^ row.text.charCodeAt(i),16777619);
  return `${prefix}:${canonical(state.url)}:${hash>>>0}`;
}

async function loadTranslations() {
  const key=contentKey("translation"),value=await chrome.storage.local.get(key);
  if(key===contentKey("translation")) {state.translations=value[key] || {};render();}
}

async function selectLanguage(mode,all=false) {
  if(!state.segments.length) {status("先提取字幕，再选择翻译。");return;}
  if(mode==="original") {state.view=mode;render();return;}
  const settings=await getSettings();
  if(!settings.deepseekApiKey) {status("中文和双语视图需要 DeepSeek Key，请点击右上角设置。",true);return;}
  if(state.translationRunning) {state.view=mode;render();return;}
  await loadTranslations();state.view=mode;render();
  const epoch=state.epoch,key=contentKey("translation");
  const limit=all ? state.segments.length : Math.min(48,state.segments.length);
  const rows=state.segments.slice(0,limit).map((row,id)=>({id,text:row.text})).filter(row=>!state.translations[row.id]);
  const batches=[];for(let i=0;i<rows.length;i+=8) batches.push(rows.slice(i,i+8));
  if(!batches.length) return;
  state.translationRunning=true;
  let cursor=0;
  const worker=async()=>{
    while(cursor<batches.length && epoch===state.epoch) {
      const batch=batches[cursor++];
      const response=await provider("translate",{title:state.title,segments:batch});
      if(epoch!==state.epoch) return;
      for(const row of response.segments) if(row.text) state.translations[row.id]=row.text;
      render();status(`译文逐段显示中：${Object.keys(state.translations).length} / ${state.segments.length}。`);
    }
  };
  try {
    const outcomes=await Promise.allSettled([worker(),worker()]);
    const failed=outcomes.find(item=>item.status==="rejected");
    if(failed) throw failed.reason;
    if(epoch===state.epoch) {
      await chrome.storage.local.set({[key]:state.translations});
      status(all ? "全文翻译完成。原字幕和时间轴已保留。" : "已翻译开头部分；需要时可点“翻译全文”。");
    }
  } catch(error) {if(epoch===state.epoch) status(error.message,true);}
  finally {state.translationRunning=false;}
}

function selectPanel(name) {
  for(const value of ["transcript","overview","notes"]) $(value+"-view").hidden=value!==name;
  for(const button of document.querySelectorAll("[data-panel]")) button.classList.toggle("selected",button.dataset.panel===name);
}

async function generateOverview() {
  if(!state.segments.length) {status("先提取字幕，再生成概览。");return;}
  const epoch=state.epoch,key=contentKey("overview");
  const cached=await chrome.storage.local.get(key);
  if(cached[key]) {$("overview-content").textContent=cached[key];return;}
  $("overview-btn").disabled=true;$("overview-content").textContent="正在依据字幕整理概览…";
  try {
    const groups=[];let text="";
    for(const row of state.segments) {
      const line=`[${stamp(row.start)}] ${row.text}\n`;
      if(text.length+line.length>60000) {groups.push(text);text="";}
      text+=line;
    }
    if(text) groups.push(text);
    const parts=[];
    for(let i=0;i<groups.length;i++) {
      if(epoch!==state.epoch) return;
      const result=await provider("overview",{title:state.title+(groups.length>1 ? `（第 ${i+1} 部分）` : ""),text:groups[i]});
      parts.push(result.text);
      if(epoch===state.epoch) $("overview-content").textContent=parts.join("\n\n");
    }
    let result=parts.join("\n\n");
    if(parts.length>1) result=(await provider("overview",{title:state.title,text:result})).text;
    if(epoch===state.epoch) {$("overview-content").textContent=result;await chrome.storage.local.set({[key]:result});}
  } catch(error) {if(epoch===state.epoch) $("overview-content").textContent=error.message;}
  finally {$("overview-btn").disabled=false;}
}

async function loadNotes() {
  const key="notes:"+canonical(state.url),data=await chrome.storage.local.get(key);
  if(key!=="notes:"+canonical(state.url)) return;
  const root=$("notes-list");root.replaceChildren();
  for(const note of data[key] || []) {
    const card=document.createElement("div");card.className="note-card";
    const time=document.createElement("button");time.textContent=stamp(note.start);time.addEventListener("click",()=>seek(note.start));
    const text=document.createElement("div");text.textContent=note.text;card.append(time,text);root.append(card);
  }
}

async function saveNote(text,time=null) {
  text=(text || "").trim();if(!text) {status("先输入笔记或选中字幕文字。");return;}
  if(time===null) {try {time=await execute(controlVideo);} catch (_) {time=0;}}
  const key="notes:"+canonical(state.url),data=await chrome.storage.local.get(key);
  const notes=data[key] || [];notes.unshift({id:crypto.randomUUID(),start:time,text,created:Date.now()});
  await chrome.storage.local.set({[key]:notes.slice(0,200)});await loadNotes();status("时间戳笔记已保存。");
}

$("read-btn").addEventListener("click", ()=>readVideo(true));
$("settings-btn").addEventListener("click",()=>chrome.runtime.openOptionsPage());
$("asr-btn").addEventListener("click", startAsr);
$("live-btn").addEventListener("click", startLive);
$("cancel-btn").addEventListener("click", cancelAsr);
$("track-select").addEventListener("change", event => chooseTrack(Number(event.target.value)));
$("search").addEventListener("input", () => {state.shown=250;render();});
$("more-btn").addEventListener("click", () => {state.shown+=250;render();});
$("copy-btn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(exportText(exportRows(),"txt",state.title));
  status("已复制带时间轴的全文。 ");
});
$("plain-btn").addEventListener("click", async () => {
  await navigator.clipboard.writeText(exportText(exportRows(),"plain"));
  status("已复制纯文字。 ");
});
for (const format of ["txt","srt","vtt"]) $(format+"-btn").addEventListener("click", () => download(format));
for(const button of document.querySelectorAll("[data-view]")) button.addEventListener("click",()=>selectLanguage(button.dataset.view));
$("translate-all").addEventListener("click",()=>selectLanguage(state.view,true));
for(const button of document.querySelectorAll("[data-panel]")) button.addEventListener("click",()=>selectPanel(button.dataset.panel));
$("overview-btn").addEventListener("click",generateOverview);
$("copy-overview").addEventListener("click",()=>navigator.clipboard.writeText($("overview-content").textContent));
$("save-note").addEventListener("click",()=>{saveNote($("note-text").value || window.getSelection()?.toString());$("note-text").value="";});
let navigationTimer;
chrome.runtime.onMessage.addListener(message=>{
  if(message?.target!=="vsa-panel") return;
  clearTimeout(navigationTimer);
  navigationTimer=setTimeout(async()=>{
    const tab=await activeTab();
    if(tab?.id && /^https?:/.test(tab.url || "") && (tab.id!==state.tabId || canonical(tab.url)!==canonical(state.url))) readVideo();
  },500);
});
window.addEventListener("pagehide", () => {
  if (state.live?.jobId) {
    navigator.sendBeacon(`${LOCAL}/live/${state.live.jobId}/stop`, "");
    state.live.stream.getTracks().forEach(track => track.stop());
  }
});
readVideo();
