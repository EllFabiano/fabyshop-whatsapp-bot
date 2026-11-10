@echo off
title Enviar Robo para o GitHub
color 0B
echo =================================================================
echo       ENVIANDO O ROBO PARA O SEU REPOSITORIO GITHUB
echo       Repositorio: https://github.com/EllFabiano/fabyshop-whatsapp-bot
echo =================================================================
echo.
cd /d "%~dp0"

git remote remove origin >nul 2>&1
git remote add origin https://github.com/EllFabiano/fabyshop-whatsapp-bot.git
git branch -M main

echo [INFO] Enviando arquivos para o GitHub...
echo (Se aparecer uma janela pedindo para autorizar no navegador, clique em "Sign in with your browser")
echo.
git push -u origin main

echo.
if %errorlevel% equ 0 (
    echo =================================================================
    echo   [SUCESSO] ARQUIVOS ENVIADOS COM SUCESSO PARA O GITHUB!
    echo =================================================================
) else (
    echo [AVISO] Ocorreu um problema no envio. Verifique o login acima.
)
echo.
pause

