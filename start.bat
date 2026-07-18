@echo off
title LedgerBot Backend - Starting...
color 0A
cls

echo ============================================
echo   LedgerBot Backend + Ngrok Startup
echo ============================================
echo.

:: Step 1: Kill any old processes
echo [1/3] Cleaning up old processes...
taskkill /IM ngrok.exe /F >nul 2>&1
echo Done.

:: Step 2: Start Node Express backend in a new window
echo [2/3] Starting LedgerBot backend on port 3000...
start "LedgerBot Backend" cmd /k "cd /d d:\Manya\Cursor-hackathon\backend && node server.js"
timeout /t 3 /nobreak >nul
echo Done.

:: Step 3: Start Ngrok tunnel with permanent static domain
echo [3/3] Starting Ngrok tunnel with static domain...
start "Ngrok Tunnel" cmd /k "cd /d d:\Manya\Cursor-hackathon && ngrok http 3000 --url=https://king-snowstorm-roundworm.ngrok-free.dev --log stdout"
echo Waiting for Ngrok to start...
timeout /t 6 /nobreak >nul

:: Step 4: Show the setup information
echo.
echo ============================================
echo   SETUP COMPLETE!
echo ============================================
echo.
echo Your PERMANENT Webhook URL is:
echo.
powershell -command "Write-Host '   https://king-snowstorm-roundworm.ngrok-free.dev/webhook' -ForegroundColor Green"
echo.
echo --------------------------------------------
echo Backend:  http://localhost:3000
echo Health:   http://localhost:3000/
echo Webhook:  https://king-snowstorm-roundworm.ngrok-free.dev/webhook
echo Verify Token: manya123
echo.
echo IMPORTANT: Meta temporary tokens expire ~24h.
echo If replies fail with 401, refresh WHATSAPP_TOKEN in backend\.env
echo from Meta Developer Dashboard → WhatsApp → API Setup.
echo --------------------------------------------
echo.
echo Both windows (LedgerBot Backend + Ngrok) are running.
echo DO NOT close those windows!
echo Frontend is NOT started (backend-only mode).
echo.
pause
