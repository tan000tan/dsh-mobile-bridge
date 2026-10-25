#!/bin/bash
# 重新创建 Android 构建所需的 ASCII 目录联接（D 盘根，仅链接、不含数据）。
# 背景：Android 构建工具不支持中文路径；本项目工具链已在项目目录内
# （临时文件与构建缓存/jdk17、AndroidSdk），但构建时必须经 ASCII 路径访问。
# 用法：bash 建立构建联接.sh    （删除：cmd /c rmdir D:\DSHJDK D:\DSHSDK D:\DSHAPP，不影响任何真实文件）
set -e
ROOT='D:\Agent工作区\ZCode工作区\DSH手机远程控制台'
CMD="New-Item -ItemType Junction -Path 'D:\DSHJDK' -Target '$ROOT\临时文件与构建缓存\jdk17\jdk-17.0.20.1+1' -Force | Out-Null; New-Item -ItemType Junction -Path 'D:\DSHSDK' -Target '$ROOT\临时文件与构建缓存\AndroidSdk' -Force | Out-Null; New-Item -ItemType Junction -Path 'D:\DSHAPP' -Target '$ROOT\手机端源码\复用DSH_Mobile客户端\dsh-mobile' -Force | Out-Null; (Test-Path 'D:\DSHJDK') -and (Test-Path 'D:\DSHSDK') -and (Test-Path 'D:\DSHAPP')"
ENC=$(printf '%s' "$CMD" | iconv -f UTF-8 -t UTF-16LE | base64 -w0)
powershell -NoProfile -EncodedCommand "$ENC" && echo "联接就绪：D:\\DSHJDK / D:\\DSHSDK / D:\\DSHAPP"
echo "构建命令：cd /d/DSHAPP && JAVA_HOME='D:\\DSHJDK' 临时文件与构建缓存/gradle-8.11.1/bin/gradle -p 'D:\\DSHAPP' assembleDebug"
