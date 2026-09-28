@echo off
chcp 65001 >nul
title RAG 知识库秘书
cd /d "%~dp0"
echo 正在启动 RAG 秘书...
python rag_server.py
pause