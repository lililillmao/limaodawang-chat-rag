@echo off
title Limao AI Toolbox - Tests
pushd "%~dp0"

echo ================================================
echo    Limao AI Toolbox - Test Suite
echo ================================================
echo.
echo   1/4  Static checks    (syntax / duplicate decls / python syntax)
echo   2/4  Tools module     (registry / safe calc / streaming / multimodal)
echo   3/4  Importer module  (ChatGPT tree / Claude / cycles / hidden msgs)
echo   4/4  Integration      (load all modules in index.html order + init())
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Tests need Node.js to run frontend unit tests.
    echo         Please install from https://nodejs.org/ and retry.
    echo.
    pause
    popd
    exit /b 1
)
echo [OK] Node.js is ready

where python >nul 2>nul
if errorlevel 1 (
    echo [WARN] Python not found. Backend syntax check will be skipped.
) else (
    echo [OK] Python is ready
)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-all.ps1"
set RC=%errorlevel%

echo.
if "%RC%"=="0" (
    echo ================================================
    echo   [DONE] All tests passed
    echo ================================================
) else (
    echo ================================================
    echo   [FAIL] Some tests failed, see output above
    echo ================================================
)
echo.
pause
popd
exit /b %RC%