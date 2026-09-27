@echo off
chcp 65001 >nul
title 狸猫AI工具盒
cd /d "%~dp0"
echo 正在启动 狸猫AI工具盒...
python rag_server.py
pause