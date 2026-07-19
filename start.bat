@echo off
setlocal EnableExtensions
title NIRVHA — Start All (Backend + Frontend + Ngrok)
color 0A
cls

:: Always run from this script's folder (repo root)
cd /d "%~dp0"

set "BACKEND_DIR=%~dp0backend"
set "FRONTEND_DIR=%~dp0frontend"
set "NGROK_URL=https://king-snowstorm-roundworm.ngrok-free.dev"
set "VERIFY_TOKEN=manya123"

echo ============================================
echo   NIRVHA — Backend + Frontend + Ngrok
echo   WhatsApp replies need ALL 3 windows open
echo ============================================
echo.

:: ---------- 1) Cleanup ----------
echo [1/5] Stopping old backend / frontend / ngrok...
taskkill /IM ngrok.exe /F >nul 2>&1

:: Free port 3000 (backend)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

:: Free port 5173 (frontend)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173" ^| findstr "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

timeout /t 2 /nobreak >nul
echo       Done.
echo.

:: ---------- 2) Backend ----------
echo [2/5] Starting backend on port 3000...
if not exist "%BACKEND_DIR%\server.js" (
  echo ERROR: backend\server.js not found at "%BACKEND_DIR%"
  pause
  exit /b 1
)
if not exist "%BACKEND_DIR%\.env" (
  echo WARNING: backend\.env missing — WhatsApp will not reply until WHATSAPP_TOKEN is set.
)
start "NIRVHA Backend" cmd /k "cd /d "%BACKEND_DIR%" && title NIRVHA Backend && node server.js"
timeout /t 4 /nobreak >nul
echo       Done.
echo.

:: ---------- 3) Frontend ----------
echo [3/5] Starting frontend on port 5173...
if not exist "%FRONTEND_DIR%\package.json" (
  echo ERROR: frontend\package.json not found
  pause
  exit /b 1
)
start "NIRVHA Frontend" cmd /k "cd /d "%FRONTEND_DIR%" && title NIRVHA Frontend && npm run dev"
timeout /t 3 /nobreak >nul
echo       Done.
echo.

:: ---------- 4) Ngrok (WhatsApp public URL) ----------
echo [4/5] Starting ngrok tunnel for WhatsApp webhook...
start "NIRVHA Ngrok" cmd /k "cd /d "%~dp0" && title NIRVHA Ngrok && ngrok http 3000 --url=%NGROK_URL% --log stdout"
echo       Waiting for tunnel...
timeout /t 7 /nobreak >nul
echo       Done.
echo.

:: ---------- 5) Health checks ----------
echo [5/5] Checking services...
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 5; Write-Host ('       Backend:  OK  ' + $r.Content) } catch { Write-Host '       Backend:  FAILED — check NIRVHA Backend window' }"
powershell -NoProfile -Command ^
  "try { $null = Invoke-WebRequest 'http://127.0.0.1:5173/' -UseBasicParsing -TimeoutSec 5; Write-Host '       Frontend: OK  http://localhost:5173' } catch { Write-Host '       Frontend: FAILED — check NIRVHA Frontend window' }"
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest '%NGROK_URL%/' -UseBasicParsing -TimeoutSec 10 -Headers @{ 'ngrok-skip-browser-warning' = '1' }; Write-Host ('       Ngrok:    OK  ' + $r.Content) } catch { Write-Host '       Ngrok:    FAILED — check NIRVHA Ngrok window / Meta webhook URL' }"

echo.
echo ============================================
echo   READY FOR WHATSAPP
echo ============================================
echo.
echo   Frontend:      http://localhost:5173
echo   Backend:       http://localhost:3000
echo   Webhook URL:   %NGROK_URL%/webhook
echo   Verify token:  %VERIFY_TOKEN%
echo.
echo   Meta Dashboard webhook must be:
echo     %NGROK_URL%/webhook
echo.
echo   Keep these 3 windows open:
echo     - NIRVHA Backend
echo     - NIRVHA Frontend
echo     - NIRVHA Ngrok
echo.
echo   If WhatsApp does not reply (401):
echo     1. Meta → WhatsApp → API Setup → new Temporary token
echo     2. Paste into backend\.env as WHATSAPP_TOKEN=...
echo     3. Close Backend window and run this file again
echo.
pause
endlocal
