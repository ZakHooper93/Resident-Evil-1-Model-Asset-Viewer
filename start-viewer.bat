@echo off
setlocal
cd /d "%~dp0"
echo Starting RE1 PS1 model viewer...
echo.
"C:\Users\zaksh\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.js
echo.
echo Server stopped. Press any key to close this window.
pause >nul
