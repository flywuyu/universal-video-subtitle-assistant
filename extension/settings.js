export const SETTINGS_KEY="vsa_settings_v3";
export const DEFAULT_SETTINGS=Object.freeze({supadataApiKey:"",deepseekApiKey:"",aiModel:"deepseek-flash",
  preferredLanguage:"auto",asrProfile:"balanced",autoAsr:true,cloudGeneration:false});

export function normalizeSettings(value={}) {
  return {...DEFAULT_SETTINGS,
    supadataApiKey:typeof value.supadataApiKey==="string" ? value.supadataApiKey.trim().slice(0,512) : "",
    deepseekApiKey:typeof value.deepseekApiKey==="string" ? value.deepseekApiKey.trim().slice(0,512) : "",
    aiModel:typeof value.aiModel==="string" && /^[\w.-]{1,80}$/.test(value.aiModel) ? value.aiModel : DEFAULT_SETTINGS.aiModel,
    preferredLanguage:["auto","zh","en"].includes(value.preferredLanguage) ? value.preferredLanguage : "auto",
    asrProfile:value.asrProfile==="fast" ? "fast" : "balanced",
    autoAsr:value.autoAsr!==false,cloudGeneration:value.cloudGeneration===true};
}
export async function getSettings() {
  const value=await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(value[SETTINGS_KEY]);
}
export async function saveSettings(value) {
  await chrome.storage.local.set({[SETTINGS_KEY]:normalizeSettings(value)});
}

export function canonicalVideoUrl(value) {
  const url=new URL(value);
  if(/(^|\.)youtube\.com$/.test(url.hostname) || url.hostname==="youtu.be") {
    const id=url.hostname==="youtu.be" ? url.pathname.split("/")[1] :
      url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
    if(!/^[\w-]{11}$/.test(id || "")) throw new Error("没有找到当前 YouTube 视频编号");
    return `https://www.youtube.com/watch?v=${id}`;
  }
  if(/(^|\.)bilibili\.com$/.test(url.hostname)) {
    const id=url.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
    if(id) return `https://www.bilibili.com/video/${id}/?p=${url.searchParams.get("p") || "1"}`;
  }
  if(/(^|\.)douyin\.com$/.test(url.hostname)) {
    const id=url.pathname.match(/\/video\/(\d+)/)?.[1] || url.searchParams.get("modal_id");
    if(id) return `https://www.douyin.com/video/${id}`;
  }
  url.hash="";
  for(const key of [...url.searchParams.keys()]) if(/^(utm_|spm_|share_|tracking)/.test(key)) url.searchParams.delete(key);
  return url.href;
}

export function supadataSupports(value) {
  const host=new URL(value).hostname;
  return ["youtube.com","youtu.be","tiktok.com","instagram.com","x.com","twitter.com","facebook.com"].some(domain=>host===domain || host.endsWith("."+domain));
}
