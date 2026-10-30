const LOCAL = "http://127.0.0.1:8765";
let starting = null;

export async function serviceRequest(path, init={}, timeout=10000) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), timeout);
  try {
    const response = await fetch(LOCAL+path, {...init, signal:control.signal});
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `本地服务错误 ${response.status}`);
    return body;
  } finally { clearTimeout(timer); }
}

export async function ensureService() {
  try {
    const data = await serviceRequest("/health", {}, 1000);
    if (data.ok && (!data.version || data.version === "0.3.0")) return data;
  } catch (_) {}
  if (!starting) {
    starting = (async () => {
      const result = await chrome.runtime.sendNativeMessage("com.video_subtitle.assistant", {action:"ensure_service"});
      if (!result?.ok) throw new Error(result?.error || "自动启动失败");
      return serviceRequest("/health", {}, 2000);
    })().catch(() => {
      throw new Error("自动启动尚未安装。请运行项目中的“安装或修复.bat”，然后在扩展页重新加载一次插件。");
    }).finally(() => {starting=null;});
  }
  return starting;
}
