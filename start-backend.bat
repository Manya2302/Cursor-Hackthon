@echo off
title LedgerBot Backend + Ngrok (always live)
color 0A
cls

echo ============================================
echo   LedgerBot — Backend + Ngrok (Facebook live)
echo ============================================
echo.

echo [1/3] Stopping old backend/ngrok...
taskkill /IM ngrok.exe /F >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
timeout /t 2 /nobreak >nul
echo Done.

echo [2/3] Starting backend on port 3000...
start "LedgerBot Backend" cmd /k "cd /d d:\Manya\Cursor-hackathon\backend && node server.js"
timeout /t 3 /nobreak >nul
echo Done.

echo [3/3] Starting ngrok (static URL for Meta webhook)...
start "Ngrok Tunnel" cmd /k "cd /d d:\Manya\Cursor-hackathon && ngrok http 3000 --url=https://king-snowstorm-roundworm.ngrok-free.dev --log stdout"
timeout /t 6 /nobreak >nul
echo Done.

echo.
echo ============================================
echo   LIVE FOR FACEBOOK / WHATSAPP
echo ============================================
echo.
echo Backend:  http://localhost:3000
echo Webhook:  https://king-snowstorm-roundworm.ngrok-free.dev/webhook
echo Verify:   manya123
echo.
echo Keep BOTH windows open (Backend + Ngrok).
echo Do not close them or Meta webhook will go down.
echo.
echo Meta token expires ~24h — refresh WHATSAPP_TOKEN in backend\.env if 401.
echo.
pause
