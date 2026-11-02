@echo off
title FX Frontend (Vite :5173)
cd /d E:\project\forext-bot
echo [FX] Starting frontend dev server on port 5173...
call npm run dev:frontend
echo.
echo [FX] Frontend exited. Press any key to close.
pause >nul
