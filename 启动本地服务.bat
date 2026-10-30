@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PYTHONUTF8=1"
set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo 请先运行“安装或修复.bat”准备本项目环境。
  pause
  exit /b 1
)
"%PY%" "%~dp0local_service\bootstrap.py"
echo.
pause
