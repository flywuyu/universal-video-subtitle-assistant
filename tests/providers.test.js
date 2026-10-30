import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchSupadataTranscript,parseSupadataResponse,translateBatch} from '../extension/providers.js';
import {canonicalVideoUrl,normalizeSettings,supadataSupports} from '../extension/settings.js';
import {readNative} from '../extension/reader.js';

const settings=normalizeSettings({supadataApiKey:'test-only'});
const nativePage={url:'https://www.youtube.com/watch?v=71ya_JC_IbM',site:'YouTube',tracks:[],nativeStatus:'blocked'};
const row={text:'>> Welcome to esports.',offset:9000,duration:2500};

test('Supadata keeps source wording and millisecond timestamps',()=>{
  assert.deepEqual(parseSupadataResponse({result:{content:[row],lang:'en'}}).segments,
    [{start:9,end:11.5,text:'>> Welcome to esports.'}]);
});

test('native request matches Digest API and never silently generates audio',async t=>{
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const u=new URL(url);
    assert.equal(u.origin,'https://api.supadata.ai');
    assert.equal(u.searchParams.get('mode'),'native');
    assert.equal(u.searchParams.get('text'),'false');
    assert.equal(u.searchParams.get('url'),nativePage.url);
    assert.equal(init.headers['x-api-key'],'test-only');
    return Response.json({content:[row],lang:'en'});
  });
  const result=await fetchSupadataTranscript(nativePage.url+'&utm_source=example',settings);
  assert.equal(result.quality,'native');
  await assert.rejects(fetchSupadataTranscript('https://example.com/audio.mp4',settings,{generate:true}),{code:'CLOUD_DISABLED'});
});

test('async Supadata job parses result.content',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>++calls===1 ? Response.json({jobId:'job'}, {status:202}) :
    Response.json({status:'completed',result:{content:[row],lang:'en'}}));
  const result=await fetchSupadataTranscript(nativePage.url,settings);
  assert.equal(calls,2);assert.equal(result.segments.length,1);
});

test('provider errors distinguish authentication, quota, and absent subtitles',async t=>{
  let status=401;
  t.mock.method(globalThis,'fetch',async()=>new Response('',{status}));
  for(const [http,code] of [[401,'INVALID_SUPADATA_KEY'],[429,'RATE_LIMITED'],[206,'NO_NATIVE_TRANSCRIPT'],[404,'NO_NATIVE_TRANSCRIPT']]) {
    status=http;await assert.rejects(fetchSupadataTranscript(nativePage.url,settings),{code});
  }
});

test('failed native read remains blocked instead of asserting no subtitles',async()=>{
  const result=await readNative({pagePromise:Promise.resolve(nativePage),forcePage:async()=>nativePage});
  assert.equal(result.blocked,true);assert.equal(result.needsSupadata,true);
});

test('provider can win immediately while page probing is pending',async()=>{
  const result=await readNative({pagePromise:new Promise(()=>{}),cloudPromise:Promise.resolve({segments:[row],quality:'native'})});
  assert.equal(result.quality,'native');
});

test('working native track wins even if Supadata rejects',async()=>{
  const result=await readNative({pagePromise:Promise.resolve({...nativePage,tracks:[{kind:'平台字幕',label:'English',segments:[{start:1,end:2,text:'Exact native text'}]}]}),
    cloudPromise:Promise.reject(Object.assign(new Error('bad key'),{code:'INVALID_SUPADATA_KEY'}))});
  assert.equal(result.segments[0].text,'Exact native text');assert.equal(result.quality,'native');
});

test('page adapter honors preferred subtitle language before manual/automatic ordering',async()=>{
  const track=(language,kind,text)=>({language,kind,label:language,segments:[{start:0,end:1,text}]});
  const page={...nativePage,tracks:[track('en','平台字幕','English'),track('ai-zh','平台自动字幕','中文')]};
  const result=await readNative({pagePromise:Promise.resolve(page),preferredLanguage:'zh'});
  assert.equal(result.segments[0].text,'中文');
});

test('DeepSeek translation preserves segment IDs and does not mutate originals',async t=>{
  const rows=[{id:15,text:'Welcome'}];
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'https://api.deepseek.com/chat/completions');
    const body=JSON.parse(init.body);assert.equal(body.thinking.type,'disabled');
    return Response.json({choices:[{message:{content:JSON.stringify({segments:[{id:15,text:'欢迎'},{id:123,text:'ignored'}]})}}]});
  });
  const translated=await translateBatch({...settings,deepseekApiKey:'test-ai'},rows);
  assert.equal(translated[0].text,'欢迎');assert.equal(rows[0].text,'Welcome');
});

test('canonical identity handles YouTube Shorts and Douyin, excluding unsupported provider platforms',()=>{
  assert.equal(canonicalVideoUrl('https://www.youtube.com/shorts/71ya_JC_IbM?feature=share'),nativePage.url);
  assert.equal(canonicalVideoUrl('https://www.douyin.com/?modal_id=7692007363368543306&foo=bar'),'https://www.douyin.com/video/7692007363368543306');
  assert.equal(supadataSupports('https://www.douyin.com/video/1'),false);
  assert.equal(supadataSupports('https://www.bilibili.com/video/BV123/'),false);
  assert.equal(supadataSupports('https://www.tiktok.com/@name/video/123'),true);
});
