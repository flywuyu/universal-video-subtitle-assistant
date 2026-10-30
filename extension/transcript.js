export function normalizeSegments(rows) {
  const result = [];
  const ordered = [...(rows || [])].sort((a,b) => Number(a.start)-Number(b.start));
  for (const row of ordered) {
    const start = Number(row.start);
    const end = Number(row.end);
    const text = String(row.text ?? "").replace(/\s+/g, " ").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !text) continue;
    const previous = result[result.length - 1];
    if (previous && previous.text === text && Math.abs(previous.start - start) < 0.5) continue;
    result.push({ start: Math.max(0, start), end: Math.max(start, end), text });
  }
  return result;
}

function asSeconds(value) {
  const parts = String(value).replace(",", ".").split(":").map(Number);
  if (parts.some(x => !Number.isFinite(x))) return NaN;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

function cleanMarkup(value) {
  return String(value).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").trim();
}

export function parseSubtitle(raw) {
  raw=typeof raw==="string" ? raw : JSON.stringify(raw ?? "");
  let data;
  try { data = JSON.parse(raw); } catch (_) { data = null; }
  if (data) {
    if (Array.isArray(data.body)) {
      return normalizeSegments(data.body.map(x => ({start:x.from,end:x.to,text:x.content})));
    }
    if (Array.isArray(data.events)) {
      return normalizeSegments(data.events.filter(x => x.segs).map(x => ({
        start: (x.tStartMs || 0) / 1000,
        end: ((x.tStartMs || 0) + (x.dDurationMs || 1000)) / 1000,
        text: (x.segs || []).map(s => s.utf8 || "").join(""),
      })));
    }
    if(Array.isArray(data.utterances)) {
      return normalizeSegments(data.utterances.map(item=>({start:Number(item.start_time ?? item.startTime ?? 0)/1000,
        end:Number(item.end_time ?? item.endTime ?? item.start_time+1000)/1000,text:item.text || item.content || ""})));
    }
    if(Array.isArray(data.captions)) {
      return normalizeSegments(data.captions.map(item=>({start:Number(item.start_time ?? item.startTime ?? 0)/1000,
        end:Number(item.end_time ?? item.endTime ?? 0)/1000,text:item.text || item.content || ""})));
    }
    if (Array.isArray(data)) return normalizeSegments(data);
  }
  const blocks = raw.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n\s*\n/);
  const rows = [];
  for (const block of blocks) {
    const lines = block.split("\n").map(x => x.trim()).filter(Boolean);
    const index = lines.findIndex(x => x.includes("-->"));
    if (index < 0) continue;
    const match = lines[index].match(/(\d{1,2}:\d{2}:\d{2}[.,]\d+|\d{1,2}:\d{2}[.,]\d+)\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d+|\d{1,2}:\d{2}[.,]\d+)/);
    if (!match) continue;
    rows.push({ start:asSeconds(match[1]), end:asSeconds(match[2]), text:cleanMarkup(lines.slice(index+1).join(" ")) });
  }
  if (rows.length) return normalizeSegments(rows);
  const xml = [...raw.matchAll(/<text\b[^>]*start="([\d.]+)"[^>]*dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)];
  if(xml.length) return normalizeSegments(xml.map(x => ({start:Number(x[1]),end:Number(x[1])+Number(x[2]),text:cleanMarkup(x[3])})));
  const srv3=[...raw.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)];
  return normalizeSegments(srv3.map(item=>{
    const begin=item[1].match(/(?:^|\s)t="([\d.]+)"/),duration=item[1].match(/(?:^|\s)d="([\d.]+)"/);
    return {start:Number(begin?.[1])/1000,end:(Number(begin?.[1])+Number(duration?.[1] || 1000))/1000,text:cleanMarkup(item[2])};
  }));
}

export function stamp(seconds, decimal = false) {
  const n = Math.max(0, Number(seconds) || 0);
  const millis = Math.round(n * 1000);
  const rounded = millis / 1000;
  const h = Math.floor(rounded / 3600);
  const m = Math.floor(rounded % 3600 / 60);
  const s = Math.floor(rounded % 60);
  const prefix = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return decimal ? `${prefix},${String(millis % 1000).padStart(3,"0")}` : (h ? prefix : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`);
}

export function exportText(segments, format, title = "") {
  const lines = normalizeSegments(segments);
  if (format === "plain") return lines.map(s => s.text).join("\n");
  if (format === "srt") return lines.map((s,i) => `${i+1}\n${stamp(s.start,true)} --> ${stamp(s.end,true)}\n${s.text}\n`).join("\n");
  if (format === "vtt") return "WEBVTT\n\n" + lines.map(s => `${stamp(s.start,true).replace(",",".")} --> ${stamp(s.end,true).replace(",",".")}\n${s.text}\n`).join("\n");
  return `${title ? title+"\n\n" : ""}${lines.map(s => `[${stamp(s.start)}] ${s.text}`).join("\n")}`;
}
