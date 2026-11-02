@echo off
title FX MT5 Bridge :tick-stream
cd /d "%~dp0.."
echo Starting MT5 bridge watchdog (streams realtime terminal ticks into the backend)...
node workers\mt5-bridge\watchdog.mjs
pause
