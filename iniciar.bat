@echo off
title FABY SHOP - Robô WhatsApp Notificador
color 0A
cd /d "%~dp0"
echo [INFO] Iniciando o servidor do robo...
echo [INFO] Mantenha esta janela aberta!
node server.js
pause
