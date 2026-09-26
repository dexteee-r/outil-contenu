@echo off
chcp 65001 >nul
rem Surveille E:\contenu\raw : chaque dossier de rushs depose est traite tout seul, puis annonce sur Discord.
rem Fermer cette fenetre (ou Ctrl+C) arrete la surveillance ; un contenu en cours sera repris au prochain lancement.
cd /d "%~dp0.."
title Surveillance des rushs
call pnpm content watch
pause
