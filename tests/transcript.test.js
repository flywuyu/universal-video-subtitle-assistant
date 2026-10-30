import test from "node:test";
import assert from "node:assert/strict";
import { parseSubtitle, exportText, normalizeSegments } from "../extension/transcript.js";

test("Bilibili BCC captions retain their timeline", () => {
  const rows = parseSubtitle(JSON.stringify({body:[
    {from:0.04,to:3.68,content:"你好"},
    {from:3.7,to:5.2,content:"世界"},
  ]}));
  assert.equal(rows.length,2);
  assert.equal(rows[0].start,0.04);
  assert.match(exportText(rows,"srt"),/00:00:00,040 --> 00:00:03,680/);
});

test("YouTube JSON3 captions are parsed", () => {
  const rows = parseSubtitle(JSON.stringify({events:[
    {tStartMs:1200,dDurationMs:2000,segs:[{utf8:"Hello "},{utf8:"world"}]},
    {tStartMs:4000,dDurationMs:500,segs:[{utf8:"bye"}]},
  ]}));
  assert.deepEqual(rows.map(x=>x.text),["Hello world","bye"]);
});

test("VTT parses timestamps and strips markup", () => {
  const rows = parseSubtitle("WEBVTT\n\n00:01.000 --> 00:02.500\n<b>字幕</b>\n\n");
  assert.deepEqual(rows,[{start:1,end:2.5,text:"字幕"}]);
  assert.match(exportText(rows,"vtt"),/^WEBVTT\n\n00:00:01.000/);
});

test("bad and duplicated lines are dropped", () => {
  const rows = normalizeSegments([
    {start:0,end:1,text:" A "}, {start:0.1,end:1.1,text:"A"},
    {start:2,end:1,text:"bad"}, {start:3,end:4,text:"B"},
  ]);
  assert.deepEqual(rows.map(x=>x.text),["A","B"]);
});
test('short-video millisecond utterances preserve words and timeline',()=>{
  assert.deepEqual(parseSubtitle({utterances:[{start_time:1200,end_time:2500,text:'字幕原文'}]}),
    [{start:1.2,end:2.5,text:'字幕原文'}]);
});
