@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:MENU
cls
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║       PUNTOS DE RESTAURACIÓN — CRM DATTASOFT        ║
echo ╚══════════════════════════════════════════════════════╝
echo.

REM Mostrar rama y último commit actual
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set RAMA=%%b
for /f "delims=" %%c in ('git log -1 --pretty^=format:"%%h - %%s" 2^>nul') do set ULTIMO=%%c
echo   Rama actual : %RAMA%
echo   Último commit: %ULTIMO%
echo.
echo ─────────────────────────────────────────────────────
echo.
echo   [1]  Crear punto de restauración (tag)
echo   [2]  Ver todos los puntos guardados
echo   [3]  Ver historial de commits
echo   [4]  Ir a un punto (solo revisar, sin cambios)
echo   [5]  Volver a main
echo   [6]  Restaurar permanentemente a un punto
echo   [7]  Comparar punto con estado actual
echo   [8]  Eliminar un punto de restauración
echo   [0]  Salir
echo.
echo ─────────────────────────────────────────────────────
set /p OPCION="  Elige una opción: "

if "%OPCION%"=="1" goto CREAR
if "%OPCION%"=="2" goto LISTAR
if "%OPCION%"=="3" goto HISTORIAL
if "%OPCION%"=="4" goto REVISAR
if "%OPCION%"=="5" goto VOLVER_MAIN
if "%OPCION%"=="6" goto RESTAURAR
if "%OPCION%"=="7" goto COMPARAR
if "%OPCION%"=="8" goto ELIMINAR
if "%OPCION%"=="0" goto SALIR

echo.
echo   ⚠  Opción no válida.
timeout /t 2 >nul
goto MENU


REM ══════════════════════════════════════════════════════
:CREAR
cls
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║            CREAR PUNTO DE RESTAURACIÓN              ║
echo ╚══════════════════════════════════════════════════════╝
echo.
echo   Ejemplo de nombre: v1.1-login-fix  v2.0-kb-completo
echo.
set /p NOMBRE="  Nombre del punto (sin espacios): "
if "%NOMBRE%"=="" (
    echo   ⚠  Nombre vacío, cancelado.
    timeout /t 2 >nul
    goto MENU
)
echo.
set /p DESCRIPCION="  Descripción breve (Enter para omitir): "
if "%DESCRIPCION%"=="" set DESCRIPCION=Punto de restauración %NOMBRE%

echo.
git tag %NOMBRE% -m "%DESCRIPCION%"
if errorlevel 1 (
    echo.
    echo   ✗  Error al crear el tag. ¿Ya existe ese nombre?
) else (
    echo   ✓  Tag '%NOMBRE%' creado localmente.
    echo.
    set /p SUBIR="  ¿Subir a GitHub ahora? [S/N]: "
    if /i "!SUBIR!"=="S" (
        git push origin %NOMBRE%
        if errorlevel 1 (
            echo   ✗  Error al subir. Revisa tu conexión.
        ) else (
            echo   ✓  Punto guardado en GitHub correctamente.
        )
    )
)
echo.
pause
goto MENU


REM ══════════════════════════════════════════════════════
:LISTAR
cls
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║          PUNTOS DE RESTAURACIÓN GUARDADOS           ║
echo ╚══════════════════════════════════════════════════════╝
echo.
git tag -l --sort=-creatordate --format="  ▸ %%(refname:short)  —  %%(subject)  [%%(creatordate:short)]" 2>nul
echo.
echo   (Sin etiquetas = no has creado ningún punto todavía)
echo.
pause
goto MENU


REM ══════════════════════════════════════════════════════
:HISTORIAL
cls
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║             HISTORIAL DE COMMITS                    ║
echo ╚══════════════════════════════════════════════════════╝
echo.
git log --oneline --decorate -20
echo.
echo   (Mostrando los últimos 20 commits)
echo.
pause
goto MENU


REM ══════════════════════════════════════════════════════
:REVISAR
cls
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║       IR A UN PUNTO (SOLO LECTURA / REVISAR)        ║
echo ╚══════════════════════════════════════════════════════╝
echo.
echo   Puntos disponibles:
git tag -l --sort=-creatordate
echo.
set /p PUNTO="  Nombre del punto a revisar: "
if "%PUNTO%"=="" goto MENU

git checkout %PUNTO% 2>nul
if errorlevel 1 (
    echo   ✗  No se encontró el punto '%PUNTO%'.
) else (
    echo.
    echo   ✓  Ahora estás viendo el código en '%PUNTO%'.
    echo   ℹ  Estás en modo "detached HEAD" — solo lectura.
    echo      Para volver a main elige la opción 5 del menú.
)
echo.
pause
goto MENU


REM ══════════════════════════════════════════════════════
:VOLVER_MAIN
cls
echo.
echo   Volviendo a la rama main...
git checkout main
if errorlevel 1 (
    echo   ✗  Error al volver a main.
) else (
    echo   ✓  De vuelta en main.
)
echo.
pause
goto MENU


REM ══════════════════════════════════════════════════════
:RESTAURAR
cls
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║        RESTAURAR PERMANENTEMENTE A UN PUNTO         ║
echo ╚══════════════════════════════════════════════════════╝
echo.
echo   ⚠  ADVERTENCIA: Esta opción descarta todos los cambios
echo      hechos DESPUÉS del punto elegido. No se puede deshacer
echo      a menos que hayas guardado commits recientes.
echo.
echo   Puntos disponibles:
git tag -l --sort=-creatordate
echo.
set /p PUNTO="  Nombre del punto a restaurar (Enter para cancelar): "
if "%PUNTO%"=="" goto MENU

echo.
echo   ¿Seguro que quieres restaurar a '%PUNTO%'?
echo   Se perderán los cambios posteriores a ese punto.
set /p CONFIRMAR="  Escribe SI para continuar: "
if not "%CONFIRMAR%"=="SI" (
    echo   Cancelado.
    timeout /t 2 >nul
    goto MENU
)

echo.
git checkout main
git reset --hard %PUNTO%
if errorlevel 1 (
    echo   ✗  Error al restaurar.
) else (
    echo   ✓  Código restaurado a '%PUNTO%'.
    echo.
    set /p SUBIR="  ¿Subir a GitHub? (sobreescribe el remoto) [S/N]: "
    if /i "!SUBIR!"=="S" (
        git push origin main --force
        echo   ✓  GitHub actualizado al punto '%PUNTO%'.
    )
)
echo.
pause
goto MENU


REM ══════════════════════════════════════════════════════
:COMPARAR
cls
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║       COMPARAR PUNTO CON ESTADO ACTUAL              ║
echo ╚══════════════════════════════════════════════════════╝
echo.
echo   Puntos disponibles:
git tag -l --sort=-creatordate
echo.
set /p PUNTO="  Nombre del punto a comparar con HEAD: "
if "%PUNTO%"=="" goto MENU

echo.
echo   Archivos que cambiaron desde '%PUNTO%':
echo   ─────────────────────────────────────────
git diff --stat %PUNTO% HEAD
echo.
pause
goto MENU


REM ══════════════════════════════════════════════════════
:ELIMINAR
cls
echo.
echo ╔══════════════════════════════════════════════════════╗
echo ║          ELIMINAR PUNTO DE RESTAURACIÓN             ║
echo ╚══════════════════════════════════════════════════════╝
echo.
echo   Puntos disponibles:
git tag -l --sort=-creatordate
echo.
set /p PUNTO="  Nombre del punto a eliminar (Enter para cancelar): "
if "%PUNTO%"=="" goto MENU

echo.
set /p CONFIRMAR="  ¿Eliminar '%PUNTO%' local y en GitHub? [S/N]: "
if /i not "%CONFIRMAR%"=="S" (
    echo   Cancelado.
    timeout /t 2 >nul
    goto MENU
)

git tag -d %PUNTO%
git push origin --delete %PUNTO% 2>nul
echo   ✓  Punto '%PUNTO%' eliminado.
echo.
pause
goto MENU


REM ══════════════════════════════════════════════════════
:SALIR
cls
echo.
echo   Hasta luego.
echo.
endlocal
exit /b 0
