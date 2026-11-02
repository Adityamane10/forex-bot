@echo off
title FX Backend (API :4000)
cd /d E:\project\forext-bot
echo [FX] Starting backend dev server on port 4000...
call npm run dev:backend
echo.
echo [FX] Backend exited. Press any key to close.
pause >nul
