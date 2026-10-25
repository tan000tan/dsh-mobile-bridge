@echo off
rem DSH 手机远程控制台 —— 桥接服务启动脚本（Windows）
rem 前提：Node.js 已安装；DSH 由你手动启动（dsh web）。
rem 本脚本只启动桥接服务，不做任何其他事情。
chcp 65001 >nul
cd /d "%~dp0"
echo [桥接] 启动 dsh-bridge（Ctrl+C 停止）...
node bridge.js
