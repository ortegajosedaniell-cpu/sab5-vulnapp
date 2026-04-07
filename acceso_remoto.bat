@echo off
title SAB-5 - Acceso Remoto (ngrok)
cd /d "%~dp0"
color 0A

echo.
echo  ==============================================
echo   SAB-5 - ACCESO REMOTO PARA SUPERVISORES
echo  ==============================================
echo.

REM ── Verificar si ngrok esta instalado ──────────────────────────
where ngrok >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] ngrok no encontrado. Instalando...
    echo.
    echo  Descargando ngrok...
    powershell -Command "Invoke-WebRequest -Uri 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile '%TEMP%\ngrok.zip'"
    powershell -Command "Expand-Archive '%TEMP%\ngrok.zip' -DestinationPath '%~dp0' -Force"
    echo  [OK] ngrok descargado en esta carpeta.
    echo.
)

REM ── Verificar si el servidor esta corriendo ────────────────────
powershell -Command "try { Invoke-WebRequest http://localhost:3000 -UseBasicParsing -TimeoutSec 2 | Out-Null } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    echo  [!] Servidor no esta corriendo. Iniciando...
    start /b "" "C:\Program Files\Git\usr\bin\perl.exe" server.pl
    timeout /t 3 /nobreak >nul
    echo  [OK] Servidor iniciado en puerto 3000
    echo.
)

echo  [OK] Servidor corriendo en http://localhost:3000
echo.
echo  Iniciando tunel publico con ngrok...
echo  Espera unos segundos y aparecera la URL publica.
echo.
echo  *** IMPORTANTE ***
echo  La URL que aparece en "Forwarding" es la que
echo  debes compartir con los supervisores.
echo  Funciona desde CUALQUIER lugar con internet.
echo  ******************
echo.

REM ── Abrir panel de ngrok en el navegador ──────────────────────
start /b cmd /c "timeout /t 4 /nobreak >nul && start http://127.0.0.1:4040"

REM ── Iniciar ngrok ─────────────────────────────────────────────
if exist "%~dp0ngrok.exe" (
    "%~dp0ngrok.exe" http 3000
) else (
    ngrok http 3000
)

pause
