@echo off
chcp 65001 >nul
rem Version avec fenetre, pour le depannage (d habitude : raccourci "Outil contenu", icone pres de l horloge).
rem Lance l outil : tableau de bord dans le navigateur + surveillance de E:\contenu\raw.
rem Fermer cette fenetre (ou Ctrl+C) arrete l outil proprement ; un contenu en cours sera repris au prochain lancement.
cd /d "%~dp0.."
title Outil contenu
call pnpm start
pause
