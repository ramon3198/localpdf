@echo off
setlocal
cd /d "%~dp0"
title LocalPDF

rem Puerto en el que se abre LocalPDF. Cambialo si el 3000 ya esta ocupado.
set "PORT=3000"

where node >nul 2>nul
if errorlevel 1 (
    echo No se encontro Node.js. Instala Node.js 22.13 o superior desde https://nodejs.org y vuelve a abrir este archivo.
    goto :error
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
    echo LocalPDF necesita Node.js 22.13 o superior. Version instalada:
    node --version
    goto :error
)

rem npm escribe este archivo al terminar una instalacion completa.
if not exist "node_modules\.package-lock.json" (
    echo Instalando dependencias, solo la primera vez...
    call npm ci
    if errorlevel 1 goto :error
)

rem Marca propia: solo existe si la ultima compilacion termino bien.
if not exist ".next\localpdf-build-ok" (
    echo Compilando LocalPDF, solo la primera vez...
    call npm run build
    if errorlevel 1 goto :error
    echo ok> ".next\localpdf-build-ok"
)

echo.
echo LocalPDF esta funcionando en http://localhost:%PORT%
echo Para detenerlo, cierra esta ventana.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT%"
call npm start -- -p %PORT%
if errorlevel 1 goto :error
goto :eof

:error
echo.
echo No se pudo iniciar LocalPDF. Revisa los mensajes de arriba.
echo Si dice que el puerto esta en uso, cierra la otra ventana de LocalPDF o cambia PORT al principio de este archivo.
pause
exit /b 1
