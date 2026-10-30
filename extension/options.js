import {getSettings,saveSettings} from "./settings.js";
const $=id=>document.getElementById(id);
const settings=await getSettings();
$("supadata-key").value=settings.supadataApiKey;$("deepseek-key").value=settings.deepseekApiKey;
$("ai-model").value=settings.aiModel;$("language").value=settings.preferredLanguage;
$("asr-profile").value=settings.asrProfile;$("auto-asr").checked=settings.autoAsr;
$("cloud-generation").checked=settings.cloudGeneration;
$("settings-form").addEventListener("submit",async event=>{
  event.preventDefault();
  await saveSettings({supadataApiKey:$("supadata-key").value,deepseekApiKey:$("deepseek-key").value,
    aiModel:$("ai-model").value,preferredLanguage:$("language").value,asrProfile:$("asr-profile").value,
    autoAsr:$("auto-asr").checked,cloudGeneration:$("cloud-generation").checked});
  $("status").textContent="设置已保存，返回视频点击重新读取即可。";
});
