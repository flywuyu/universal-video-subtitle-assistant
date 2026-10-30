"""Prepare a project-local environment before registering the Windows bridge."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT = ROOT / '.venv'
REQUIRED = ('yt-dlp', 'youtube-transcript-api', 'openai-whisper', 'imageio-ffmpeg', 'av', 'numpy', 'psutil')


def main():
    parser = argparse.ArgumentParser(description='安装本机语音服务与当前用户的浏览器自动启动连接')
    parser.add_argument('--repair-dependencies', action='store_true', help='重新安装/升级 requirements 中的依赖')
    parser.add_argument('--prepare-only', action='store_true', help='仅准备依赖，不注册连接或启动服务')
    args = parser.parse_args()
    if os.name != 'nt':
        parser.error('自动安装目前仅支持 Windows。浏览器扩展可单独安装。')
    if sys.version_info < (3, 11):
        parser.error('请先安装 Python 3.11 或更高版本。')
    python = ENVIRONMENT / 'Scripts' / 'python.exe'
    if not python.exists():
        print('正在创建本项目专用 Python 环境…', flush=True)
        venv.create(ENVIRONMENT, with_pip=True)
    check = subprocess.run([str(python), '-c',
        'import importlib.metadata as m,sys; '
        'available={d.metadata["Name"].lower().replace("_","-") for d in m.distributions()}; '
        'sys.exit(0 if set(sys.argv[1:]) <= available else 1)', *REQUIRED], check=False)
    if args.repair_dependencies or check.returncode:
        print('正在安装语音识别依赖，首次安装可能需要较长时间…', flush=True)
        subprocess.run([str(python), '-m', 'pip', 'install', '-r',
                        str(ROOT / 'local_service' / 'requirements.txt')], check=True)
    if not args.prepare_only:
        subprocess.run([str(python), '-X', 'utf8', str(ROOT / 'local_service' / 'install.py')], check=True)
    print('环境准备完成。', flush=True)


if __name__ == '__main__':
    main()
