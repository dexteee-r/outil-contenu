@echo off
rem Ouvre la page des miniatures d inspiration (laisser cette fenetre ouverte pendant l utilisation)
cd /d "%~dp0.."
title Miniatures d inspiration
call pnpm miniatures
pause
