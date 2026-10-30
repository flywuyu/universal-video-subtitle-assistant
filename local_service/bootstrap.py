"""Start the service detached from any console and check its real health."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.request import build_opener, ProxyHandler

HERE = Path(__file__).resolve().parent
OPENER = build_opener(ProxyHandler({}))


def health():
    try:
        with OPENER.open("http://127.0.0.1:8765/health", timeout=0.8) as response:
            data = json.load(response)
            if data.get("app") == "video-subtitle-assistant" and data.get("version") == "0.3.0":
                return data
    except Exception:
        pass
    return None


def ensure_service():
    if health():
        return health()
    python = Path(sys.executable).with_name("pythonw.exe")
    if not python.exists():
        python = Path(sys.executable)
    subprocess.Popen([str(python), "-X", "utf8", str(HERE / "server.py"), "--background"],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) |
                     getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0), close_fds=True)
    for _ in range(120):
        data = health()
        if data:
            return data
        time.sleep(0.1)
    raise RuntimeError("本地识别服务未能启动，请查看 local_service/logs/service.log")


def restart_service():
    import psutil
    target = (HERE / "server.py").resolve()
    for process in psutil.process_iter(["pid", "cmdline", "name"]):
        if process.info["pid"] == os.getpid() or process.info["name"].lower() not in ("python.exe", "pythonw.exe"):
            continue
        args = process.info.get("cmdline") or []
        if any(Path(arg).is_absolute() and Path(arg).resolve() == target for arg in args[1:]
               if not arg.startswith("-")):
            process.terminate()
            try:
                process.wait(timeout=5)
            except psutil.TimeoutExpired:
                process.kill()
    return ensure_service()


if __name__ == "__main__":
    restart_service() if "--restart" in sys.argv else ensure_service()
    print("字幕服务已在后台启动。可以关闭此窗口，回到视频点击插件。")
