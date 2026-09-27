@echo off
chcp 65001 >nul
title 狸猫AI工具盒 - 启动器
pushd "%~dp0"

echo ================================================
echo    狸猫AI工具盒  -  启动中
echo ================================================
echo.

REM ---- 1. 检查 Python ----
where python >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Python。
    echo.
    echo 请到 https://www.python.org/downloads/ 下载安装 Python 3.10+
    echo 安装时务必勾选 "Add Python to PATH"。
    echo.
    pause
    popd
    exit /b 1
)
echo [OK] Python 已就绪

REM ---- 2. 检查 Ollama（不强制，连不上只警告） ----
curl -s -o nul --max-time 2 http://127.0.0.1:11434/api/tags
if errorlevel 1 (
    echo [警告] 未检测到 Ollama 服务，本地模型功能将不可用。
    echo        如果已安装 Ollama，请先启动它再运行本脚本。
    echo.
) else (
    echo [OK] Ollama 已连接
)

echo.
echo 正在启动服务，请稍候...
echo.

REM ---- 3. 启动 RAG 后端（端口 8000） ----
start "狸猫 - RAG后端 (8000)" cmd /k "python rag_server.py"
timeout /t 2 /nobreak >nul

REM ---- 4. 启动前端静态服务器（端口 5500） ----
start "狸猫 - 前端 (5500)" cmd /k "python -m http.server 5500"
timeout /t 2 /nobreak >nul

REM ---- 5. 打开浏览器 ----
start "" http://127.0.0.1:5500/index.html

echo ================================================
echo   [完成] 服务已启动！
echo.
echo   前端界面 : http://127.0.0.1:5500
echo   后端 API : http://127.0.0.1:8000
echo.
echo   要停止服务：直接关闭那两个黑框窗口即可。
echo   本窗口 3 秒后自动关闭。
echo ================================================
timeout /t 3 /nobreak >nul
popd
exit /b 0