@echo off
title SecureReport - Sistema de Vulnerabilidades
cd /d "%~dp0"

echo.
echo  ==========================================
echo   SecureReport - Iniciando servidor...
echo  ==========================================
echo.

REM Verificar si existe .env, sino copiar el ejemplo
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo  [!] Archivo .env creado. Editalo para agregar tu clave de IA.
        echo.
    )
)

REM Crear carpeta data si no existe
if not exist "data" mkdir data
if not exist "uploads" mkdir uploads

echo  Abriendo navegador en http://localhost:3000
echo  Presiona Ctrl+C para detener el servidor
echo.
echo  Usuario: admin
echo  Clave:   admin123
echo.

REM Abrir el navegador despues de 2 segundos
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

REM Iniciar el servidor Perl
"C:\Program Files\Git\usr\bin\perl.exe" server.pl

pause
