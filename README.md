# DSH 手机远程控制台 · 电脑端桥接服务

![Node.js](https://img.shields.io/badge/Runtime-Node%20%E2%89%A5%2020-green?logo=nodedotjs)
![Deps](https://img.shields.io/badge/Dependencies-零第三方-brightgreen)
![Security](https://img.shields.io/badge/Security-fail--closed%20%2B%20审计日志-red)
![License](https://img.shields.io/badge/Platform-Windows%20%2F%20Linux-lightgrey)

让手机跨机访问只监听回环地址的 DeepSeek Harness（DSH）Web profile 的**零依赖 Node.js 反向代理**，配套完整的安全审查、验收与交付文档。

> 📱 配套手机端：<https://github.com/tan000tan/dsh-mobile-console>

---

## 💡 为什么需要它

DSH `0.1.7-rc.2` 的 web profile 默认只监听 `127.0.0.1:3080`，官方明确拒绝绑定 `0.0.0.0`（会暴露远程代码执行面）。手机在另一台设备上无法直连，于是用一个电脑端桥接进程把「手机请求 → 本机回环 DSH」这段接起来，**不修改 DSH 的任何文件或配置**。

## ✨ 特性

- **零第三方依赖**（仅 Node.js 标准库），单文件 `bridge/bridge.js`（约 630 行）
- **设备台账** `devices.json` 只存 `tokenHash`（SHA-256），明文令牌只在 `add`/`rotate` 时打印一次；支持按设备撤销
- **默认仅绑定 `127.0.0.1`**；绑定非回环地址时启动横幅明文告警（网络可达 ≠ 授权）
- **可选 TLS**：配置 `tls: {pfxPath}` 后仅以 HTTPS 监听，禁降级
- **审计日志**按天落盘（`审计日志/`，默认保留 30 天），可配置级别
- **失败关闭（fail-closed）**：既无令牌也无设备台账时拒绝启动

## 📂 目录

```text
bridge/
├─ bridge.js                 桥接服务主体（反向代理 + 设备令牌 + 审计）
├─ 桥接配置.example.json     配置模板（不含真实令牌）
├─ 桥接服务说明.md           参数、协议、故障排查
├─ 启动桥接服务.bat / .sh    前台启动
├─ 启动托盘.bat / .ps1       托盘方式启动
├─ 建立TLS证书.ps1           生成自签证书（含 127.0.0.1）
└─ 建立构建联接.sh           构建用的目录联接脚本
docs/
├─ 最终交付文档/             交付报告、验收、升级回滚、故障排查
├─ 安全审查与兼容性报告/     认证/网络/审批专项审计、真实环境验证
├─ 二期规划_扫码融合与GitHub开源/  规划书与决策记录
├─ 原始环境检查记录/         本机环境与可达性实测
└─ 手机端源码/               手机端来源与复用说明
```

## 🚀 快速开始

```bash
cd bridge
node bridge.js            # 首次运行会生成 桥接配置.json 与 devices.json，并打印一次性设备令牌
node bridge.js --help     # 查看 add / rotate / revoke 等子命令
```

默认监听 `http://127.0.0.1:3090`，转发到本机 DSH `http://127.0.0.1:3080`。

手机端访问时需要携带设备令牌（路径或请求头，见 `bridge/桥接服务说明.md`）。要让手机跨机访问，把 `listenHost` 改成电脑的局域网 IP，并保持设备令牌开启。

## 🔐 安全说明

- 本仓库**不含**任何令牌、设备台账、审计日志：`桥接配置.json`、`devices.json`、`设备令牌_一次性.txt`、`审计日志/` 均由 `.gitignore` 排除。首次运行会重新生成。
- `桥接配置.example.json` 仅为模板，其中的值都是占位默认值。
- 桥接本身不做权限提升：DSH 的审批策略仍然生效，桥接只转发 HTTP。

## 📦 未包含的内容

- 手机端上游客户端 `dsh-mobile`（第三方项目，按其自身许可证使用，见 `docs/手机端源码/` 的溯源说明）
- 开源项目研究目录（各上游仓库的本地 clone）
- 构建产物与安装包（APK/AAB，体积大且二进制）
- 构建缓存与本地环境（JDK/SDK 目录联接）
