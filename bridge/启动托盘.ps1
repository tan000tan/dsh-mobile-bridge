# DSH 手机远程控制台 —— 桥接托盘程序（需求基线 #12/#28：默认托盘形态）
#
# 作用：系统托盘图标 + 菜单（启动桥接 / 停止桥接 / 状态 / 设备列表 / 退出），
#       以子进程方式运行 node bridge.js；崩溃不自动重启（不掩盖故障），由菜单手动重启。
# 边界：不安装服务、不写注册表、不开机自启（如需自启由用户自行配置，属需批准事项）。
# 运行：powershell -ExecutionPolicy Bypass -File 启动托盘.ps1   （或双击 启动托盘.bat）
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:bridgeProcess = $null
$script:bridgeConfig = Join-Path $PSScriptRoot "桥接配置.json"

function Get-BridgeRunning {
    return ($null -ne $script:bridgeProcess -and -not $script:bridgeProcess.HasExited)
}

function Start-Bridge {
    if (Get-BridgeRunning) { [System.Windows.Forms.MessageBox]::Show("桥接已在运行", "dsh-bridge") | Out-Null; return }
    $script:bridgeProcess = Start-Process -FilePath "node" `
        -ArgumentList "`"$(Join-Path $PSScriptRoot 'bridge.js')`"" `
        -WorkingDirectory $PSScriptRoot `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $PSScriptRoot "托盘桥接输出.log") `
        -RedirectStandardError (Join-Path $PSScriptRoot "托盘桥接错误.log")
}

function Stop-Bridge {
    if (Get-BridgeRunning) {
        try { $script:bridgeProcess.Kill() } catch {}
        $script:bridgeProcess = $null
    }
}

function Show-Status {
    $running = Get-BridgeRunning
    $dsh = "?"
    try {
        $cfg = Get-Content $script:bridgeConfig -Raw -Encoding UTF8 | ConvertFrom-Json
        $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://$($cfg.dshHost):$($cfg.dshPort)/"
        $dsh = "DSH 可达"
    } catch { $dsh = "DSH 不可达（未启动或端口不符）" }
    [System.Windows.Forms.MessageBox]::Show(
        "桥接进程：$(if ($running) {'运行中'} else {'已停止'})`n$($dsh)`n`n管理命令：node bridge.js devices list|add|revoke|rotate",
        "dsh-bridge 状态") | Out-Null
}

$icon = [System.Drawing.SystemIcons]::Application
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = "DSH 桥接（未运行）"
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripMenuItem("启动桥接", $null, { Start-Bridge }))) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripMenuItem("停止桥接", $null, { Stop-Bridge }))) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripMenuItem("状态", $null, { Show-Status }))) | Out-Null
$menu.Items.Add("-") | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripMenuItem("退出", $null, {
    Stop-Bridge
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
}))) | Out-Null
$tray.ContextMenuStrip = $menu

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
    $tray.Text = "DSH 桥接（$(if (Get-BridgeRunning) {'运行中'} else {'未运行'})）"
})
$timer.Start()

Start-Bridge  # 打开托盘即自动启动桥接（托盘即"默认形态"；停止/退出由菜单控制）
[System.Windows.Forms.Application]::Run()
