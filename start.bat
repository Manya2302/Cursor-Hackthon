@echo off
title NIRVHA - Starting...
color 0A
cls

echo ============================================
echo   NIRVHA Backend + Frontend + Ngrok
echo ============================================
echo.

:: Step 1: Kill any old processes
echo [1/4] Cleaning up old processes...
taskkill /IM ngrok.exe /F >nul 2>&1
echo Done.

:: Step 2: Start Node Express backend in a new window
echo [2/4] Starting NIRVHA backend on port 3000...
start "NIRVHA Backend" cmd /k "cd /d d:\Manya\Cursor-hackathon\backend && node server.js"
timeout /t 3 /nobreak >nul
echo Done.

:: Step 3: Start frontend (Vite)
echo [3/4] Starting frontend on port 5173...
start "NIRVHA Frontend" cmd /k "cd /d d:\Manya\Cursor-hackathon\frontend && npm run dev"
timeout /t 2 /nobreak >nul
echo Done.

:: Step 4: Start Ngrok tunnel with permanent static domain
echo [4/4] Starting Ngrok tunnel with static domain...
start "Ngrok Tunnel" cmd /k "cd /d d:\Manya\Cursor-hackathon && ngrok http 3000 --url=https://king-snowstorm-roundworm.ngrok-free.dev --log stdout"
echo Waiting for Ngrok to start...
timeout /t 6 /nobreak >nul

:: Step 5: Show the setup information
echo.
echo ============================================
echo   SETUP COMPLETE!
echo ============================================
echo.
echo Frontend: http://localhost:5173
echo Backend:  http://localhost:3000
echo Webhook:  https://king-snowstorm-roundworm.ngrok-free.dev/webhook
echo Verify Token: manya123
echo.
echo IMPORTANT: Meta temporary tokens expire ~24h.
echo If replies fail with 401, refresh WHATSAPP_TOKEN in backend\.env
echo.
echo Keep the Backend, Frontend, and Ngrok windows open.
echo.
pause
