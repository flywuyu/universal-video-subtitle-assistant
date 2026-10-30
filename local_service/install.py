"""Register this project's native bridge for the current Windows user only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import winreg

from bootstrap import restart_service

HERE = Path(__file__).resolve().parent
NAME = "com.video_subtitle.assistant"
ORIGIN = "chrome-extension://ioakbhlnnjbcmcndpgllclgjpjnohaoc/"


def main():
    compiler = Path(os.environ["WINDIR"]) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    subprocess.run([str(compiler), "/nologo", "/target:exe", "/reference:System.Web.Extensions.dll",
                    "/out:" + str(HERE / "SubtitleNativeHost.exe"), str(HERE / "NativeHost.cs")], check=True)
    python = Path(sys.executable).with_name("pythonw.exe")
    if not python.exists():
        python = Path(sys.executable)
    (HERE / "host_config.json").write_text(json.dumps({"python":str(python), "server":str(HERE / "server.py")},
                                                      ensure_ascii=False, indent=2), encoding="utf-8")
    manifest = HERE / "native_host.json"
    manifest.write_text(json.dumps({"name": NAME, "description":"Video subtitle service launcher",
                                    "path":str(HERE / "SubtitleNativeHost.exe"), "type":"stdio",
                                    "allowed_origins":[ORIGIN]}, ensure_ascii=False, indent=2), encoding="utf-8")
    for browser in ("Microsoft\\Edge", "Google\\Chrome", "Chromium"):
        key_path = "Software\\" + browser + "\\NativeMessagingHosts\\" + NAME
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key_path, 0, winreg.KEY_SET_VALUE) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest))
    restart_service()
    print("自动启动连接已安装，本地服务已运行。请在扩展页重新加载插件一次。")


if __name__ == "__main__":
    main()
