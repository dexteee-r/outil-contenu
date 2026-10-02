@echo off
rem Lance l outil sans fenetre : icone pres de l horloge, tableau de bord, surveillance de /raw.
rem Appele par le raccourci "Outil contenu" (conhost --headless), cree par : pnpm cli tray:setup
rem Journal de lancement propre a chaque lancement (le precedent peut encore tourner et garder le
rem sien ouvert) : ouvert dans le Bloc-notes si le demarrage echoue, supprime sinon.
rem Le journal de l outil lui-meme est dans <DATA_ROOT>\logs.
cd /d "%~dp0.."
set "LAUNCH_LOG=%TEMP%\outil-contenu-lancement-%RANDOM%%RANDOM%.log"
call pnpm start --tray > "%LAUNCH_LOG%" 2>&1
if errorlevel 1 if not errorlevel 2 (
  start "" notepad "%LAUNCH_LOG%"
  exit /b 1
)
del "%LAUNCH_LOG%" 2>nul
