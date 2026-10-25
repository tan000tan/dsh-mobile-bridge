#!/bin/bash
# DSH 手机远程控制台 —— 桥接服务启动脚本（Git Bash）
# 前提：Node.js 已安装；DSH 由你手动启动（dsh web）。
cd "$(dirname "$0")"
echo "[桥接] 启动 dsh-bridge（Ctrl+C 停止）..."
exec node bridge.js
