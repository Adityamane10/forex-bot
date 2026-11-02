@echo off
title FX AI Engine (uvicorn :8500)
cd /d E:\project\forext-bot
echo [FX] Starting AI engine on port 8500...
call npm run dev:ai
echo.
echo [FX] AI engine exited. Press any key to close.
pause >nul
