import test from "node:test";
import assert from "node:assert/strict";
import { probePage } from "../extension/pageProbe.js";

test("Bilibili page metadata yields matched subtitle and audio track", async () => {
  globalThis.location = {href:"https://www.bilibili.com/video/BV123/?p=1",hostname:"www.bilibili.com",pathname:"/video/BV123/",search:"?p=1",origin:"https://www.bilibili.com"};
  globalThis.document = {title:"Example",querySelector:selector => selector === "h1" ? {textContent:"当前视频"} : null};
  globalThis.window = {
    __INITIAL_STATE__:{videoData:{bvid:"BV123",aid:22,cid:33,pages:[{cid:33}],subtitle:{list:[
      {subtitle_url:"//aisubtitle.hdslb.com/a.json",lan:"ai-zh",lan_doc:"中文（AI）"},
    ]}}},
    __playinfo__:{data:{dash:{audio:[{bandwidth:192000,baseUrl:"https://a.bilivideo.com/high.m4s"},
      {bandwidth:64000,baseUrl:"https://a.bilivideo.com/low.m4s"}]}}},
  };
  globalThis.performance = {getEntriesByType:()=>[]};
  const page = await probePage();
  assert.equal(page.tracks.length,1);
  assert.equal(page.tracks[0].url,"https://aisubtitle.hdslb.com/a.json");
  assert.equal(page.audioUrl,"https://a.bilivideo.com/low.m4s");
});

test("stale Bilibili state is ignored after navigation", async () => {
  globalThis.location = {href:"https://www.bilibili.com/video/BV999/",hostname:"www.bilibili.com",pathname:"/video/BV999/",search:"",origin:"https://www.bilibili.com"};
  const page = await probePage();
  assert.equal(page.tracks.length,0);
  assert.equal(page.audioUrl,undefined);
});

function setup(url,overrides={}) {
  globalThis.location=new URL(url);
  globalThis.document={title:'Example',querySelector:()=>null,querySelectorAll:()=>[],...overrides};
  globalThis.performance={getEntriesByType:()=>[]};
  globalThis.window={};
}

test('YouTube SPA uses current player instead of stale initial state',async()=>{
  setup('https://www.youtube.com/watch?v=71ya_JC_IbM',{querySelector:selector=>selector==='#movie_player' ?
    {getPlayerResponse:()=>({videoDetails:{videoId:'71ya_JC_IbM',title:'Current'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[
      {baseUrl:'https://www.youtube.com/api/timedtext?v=71ya_JC_IbM',languageCode:'en'}]}}})}:null});
  window.ytInitialPlayerResponse={videoDetails:{videoId:'old12345678',title:'Wrong'}};
  const page=await probePage();assert.equal(page.title,'Current');assert.equal(page.tracks.length,1);
});

test('captured YouTube captions are bound to current video',async()=>{
  setup('https://www.youtube.com/watch?v=71ya_JC_IbM');
  window.__VSA_NETWORK__={entries:[{kind:'youtube-captions',videoId:'old12345678',value:{raw:'old'}},
    {kind:'youtube-captions',videoId:'71ya_JC_IbM',value:{raw:'current'}}]};
  const page=await probePage();assert.equal(page.tracks.length,1);assert.equal(page.tracks[0].raw,'current');
});

test('Douyin selects the current video from mixed feed metadata',async()=>{
  setup('https://www.douyin.com/video/123456');
  window._ROUTER_DATA={items:[{aweme_id:'999999',desc:'Wrong feed item',video:{play_addr:{url_list:['https://wrong.example/']}}},
    {aweme_id:'123456',desc:'Current video',video:{duration:60000,play_addr:{url_list:['https://video.example/current.mp4']},
      cla_info:{caption_infos:[{lang:'zh',url:'https://video.example/current.json'}]}}}]};
  const page=await probePage();assert.equal(page.title,'Current video');assert.equal(page.duration,60);
  assert.equal(page.tracks.length,1);assert.equal(page.audioUrl,'https://video.example/current.mp4');
});

test('restricted page stays blocked and does not invent caption absence',async()=>{
  setup('https://www.youtube.com/watch?v=71ya_JC_IbM');
  const page=await probePage();assert.equal(page.nativeStatus,'blocked');assert.equal(page.tracks.length,0);
});

test('Bilibili player address format 1 resolves to the current subtitle CDN',async()=>{
  setup('https://www.bilibili.com/video/BV123/');
  window.__INITIAL_STATE__={videoData:{bvid:'BV123',aid:22,cid:33,pages:[{cid:33}],subtitle:{list:[
    {lan:'ai-zh',lan_doc:'中文',subtitle_url:"//subtitle.bilibili.com/S%13%1BP.%1D%28%29X%2CR%5Ej%1F%25w%0E%02H%5EHO4%14%7B4%08K%40%3C%7B%00M%0B%0A%1AM%08%056N6%24%0C0%26%02%1E%01%09%0E%1A2V%29M%0D%1CS%01%0CF%13%09O%3AG%06%02hE%13%0D%07?auth_key=test-only"}]}}};
  window.__playinfo__={data:{dash:{audio:[{baseUrl:'https://a.bilivideo.com/audio.m4s'}]}}};
  const page=await probePage();
  assert.equal(page.tracks[0].url,'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/fixture-caption.json?auth_key=test-only');
});

test('Bilibili player address format 2 resolves to the current subtitle CDN',async()=>{
  setup('https://www.bilibili.com/video/BV123/');
  window.__INITIAL_STATE__={videoData:{bvid:'BV123',aid:22,cid:33,pages:[{cid:33}],subtitle:{list:[
    {lan:'ai-zh',lan_doc:'中文',subtitle_url:"//subtitle.bilibili.com/%01%1B%5C%3D_%04%12%12%049f%2F%07H%08%29~%16%245%0D.%0B%0AL%03%2C%01%1A%00M%3A%1Ce%00%0F%1FF%03%003%1A6%17%0A%25U%14%16Q%16%2CI%16oA%1F%10I%04%2F%14V%06%04%1E%13C%1C%2BI4%18%1FM?auth_key=test-only"}]}}};
  window.__playinfo__={data:{dash:{audio:[{baseUrl:'https://a.bilivideo.com/audio.m4s'}]}}};
  const page=await probePage();
  assert.equal(page.tracks[0].url,'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/fixture-caption.json?auth_key=test-only');
});
