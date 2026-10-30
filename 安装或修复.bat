@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
if exist "%~dp0.venv\Scripts\python.exe" (
  "%~dp0.venv\Scripts\python.exe" -X utf8 "%~dp0local_service\setup_service.py"
) else (
  where py >nul 2>nul
  if errorlevel 1 (
    python -X utf8 "%~dp0local_service\setup_service.py"
  ) else (
    py -3 -X utf8 "%~dp0local_service\setup_service.py"
  )
)
if errorlevel 1 echo 安装未完成。请检查 Python 版本、网络和上方错误提示。
pause
