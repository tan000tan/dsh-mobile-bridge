@echo off
rem DSH 手机远程控制台 —— 桥接托盘程序启动（需求基线 #12 默认形态）
rem 关闭方式：托盘图标右键 → 退出。
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动托盘.ps1"
