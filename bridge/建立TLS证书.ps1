# DSH 手机远程控制台 —— TLS 证书生成脚本（需求基线 #29：加密传输/服务器身份验证）
#
# 作用：创建自签证书（含本机名/localhost/可选局域网 IP 的 SAN），导出 PFX 供桥接服务以
#       HTTPS 监听（配置 桥接配置.json 的 "tls": {"pfxPath": ...}，配置后仅 HTTPS、禁止降级）。
# 边界：仅在本机证书库创建并导出到本文件所在目录；不改系统配置、不开端口、不自动启动任何服务。
# 运行：以当前用户身份运行 PowerShell 执行本脚本（无需管理员）；参数 -LanIp 可加入局域网地址。
# 信任：手机端需将导出的 .cer 安装为"用户凭据"，并在桥接启动横幅核对证书 SHA-256 指纹。
param(
    [string]$LanIp = ""
)
$ErrorActionPreference = "Stop"

$DnsName = $env:COMPUTERNAME
$DnsList = @($DnsName, "localhost")
$IpList = @("127.0.0.1")
if ($LanIp -ne "") { $IpList += $LanIp }

$Subject = "CN=DSH Console Bridge"
$NotAfter = (Get-Date).AddYears(2)

Write-Host "[证书] 创建自签证书 CN=$DnsName ..."
$Cert = New-SelfSignedCertificate -Subject $Subject `
    -DnsName $DnsList `
    -IpAddress $IpList `
    -NotAfter $NotAfter `
    -KeyAlgorithm RSA -KeyLength 2048 `
    -KeyExportPolicy Exportable `
    -CertStoreLocation "Cert:\CurrentUser\My"

$OutDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PfxPath = Join-Path $OutDir "桥接TLS证书.pfx"
$CerPath = Join-Path $OutDir "桥接TLS证书.cer"
$Pass = [System.Web.Security.Membership]::GeneratePassword(24, 4) 2>$null
if (-not $Pass) { $Pass = [guid]::NewGuid().ToString("N") + "!Aa1" }

Write-Host "[证书] 导出 PFX -> $PfxPath"
$SecurePass = ConvertTo-SecureString -String $Pass -Force -AsPlainText
Export-PfxCertificate -Cert $Cert -FilePath $PfxPath -Password $SecurePass | Out-Null
Export-Certificate -Cert $Cert -FilePath $CerPath | Out-Null

Write-Host "[证书] 完成。"
Write-Host "[证书] 指纹(SHA-256，供手机端核对)：$($Cert.Thumbprint)"
Write-Host "[下一步]"
Write-Host "  1. 在 桥接配置.json 中加入："
Write-Host '     "tls": { "pfxPath": "<本目录>\\桥接TLS证书.pfx", "passphrase": "<上方口令>" }'
Write-Host "  2. 重启桥接服务——此后仅 HTTPS 监听（明文 HTTP 不再可用，禁止降级）。"
Write-Host "  3. 手机端：设置→安全→安装证书→CA 证书，安装 $CerPath；"
Write-Host "     主机地址改为 https://<电脑IP>:<端口>/<设备令牌>，并与横幅指纹核对。"
Write-Host "[注意] 口令已打印于上方第 2 步说明中，请自行保存；PFX 与口令同机存放属于本机信任边界内。"
