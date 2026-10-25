#!/usr/bin/env node
/*
 * dsh-bridge —— DSH 手机远程控制台 · Windows 桥接服务
 *
 * 职责：把手机端对 DSH web profile 的访问反向代理到仅回环监听的 DSH（127.0.0.1:3080），
 *       使手机可以跨机访问而无需修改 DSH 任何文件/配置（0.1.7-rc.2 官方拒绝 0.0.0.0 绑定）。
 *
 * 安全设计（需求基线 #8/#12/#24/#25/#28/#29/#31/#33）：
 *   - 设备凭据：每台设备独立令牌（devices.json），可单独撤销/轮换；撤销即刻失效；
 *     令牌仅存 SHA-256 哈希，明文只在 add/rotate 时打印一次。旧版单令牌配置自动迁移。
 *   - 常量时间比较：两侧先 SHA-256 定长化再 timingSafeEqual，消除长度/内容时序泄漏。
 *   - fail-closed：令牌缺失/不匹配/已撤销一律 401；配置令牌为空拒绝启动。
 *   - 滥用防护：按源 IP 的认证失败滑动窗口限速，超限临时封禁（内存态），产生审计事件。
 *   - 审计日志：JSONL 落盘（等级/保留期可配置），绝不记录令牌、Cookie、URL 查询串、请求体。
 *   - 传输安全（可选）：配置 TLS 证书后仅以 HTTPS 监听（禁止降级到明文）；
 *     启动横幅打印证书 SHA-256 指纹供设备侧身份核验。
 *   - 默认仅绑定 127.0.0.1；绑定非回环地址时启动横幅明文警告（网络可达≠授权）。
 *
 * 接入方式（手机端，DSH Mobile 原生支持 basePath）：
 *   主机地址填 http(s)://<电脑IP>:<端口>/<设备令牌>
 *
 * 设备管理（本机 CLI，管理面永远不暴露到网络）：
 *   node bridge.js devices list
 *   node bridge.js devices add <名称>
 *   node bridge.js devices revoke <设备id>
 *   node bridge.js devices rotate <设备id>
 *
 * 运行：node bridge.js [配置文件路径]   （默认与本文件同目录的 桥接配置.json）
 * 依赖：Node.js ≥ 18，零第三方依赖。
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = '1.1.1'; // 1.1.1：设备台账跨进程热重载（CLI 撤销/轮换即刻生效，阶段 C 修复 A-22）
const TOKEN_SEGMENT = /^[A-Za-z0-9_-]{32,128}$/; // 路径首段令牌的形态约束

/* ---------------------------------------------------------------- 工具 */

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 常量时间令牌比较：定长化后比较，空令牌直接拒绝。 */
function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(sha256Hex(provided), 'hex');
  const b = Buffer.from(sha256Hex(expected), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

function randomId() {
  return crypto.randomBytes(6).toString('hex');
}

/* ---------------------------------------------------------------- 审计日志 */

/**
 * JSONL 审计日志：事件一行一条；绝不记录令牌/Cookie/查询串/请求体。
 * 等级：error > warn > info > debug；retentionDays 到期文件在滚动清理时删除。
 */
class AuditLog {
  constructor(dir, options, logger) {
    this.dir = dir;
    this.level = (options && options.level) || 'info';
    this.retentionDays = Number((options && options.retentionDays) || 30);
    this.logger = logger || { log: () => {} };
    this.steps = { error: 0, warn: 1, info: 2, debug: 3 };
    fs.mkdirSync(dir, { recursive: true });
    this.cleanup();
  }

  cleanup() {
    try {
      const cutoff = Date.now() - this.retentionDays * 86400_000;
      for (const name of fs.readdirSync(this.dir)) {
        const m = name.match(/^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!m) continue;
        if (new Date(m[1] + 'T00:00:00Z').getTime() < cutoff) {
          fs.unlinkSync(path.join(this.dir, name));
          this.logger.log(`[审计] 清理过期日志 ${name}`);
        }
      }
    } catch (_) { /* 审计清理失败不影响服务 */ }
  }

  write(level, event, fields) {
    if ((this.steps[level] ?? 2) > this.steps[this.level]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
    const name = `audit-${new Date().toISOString().slice(0, 10)}.jsonl`;
    try {
      fs.appendFileSync(path.join(this.dir, name), line + '\n', 'utf8');
    } catch (_) { /* 审计写失败不影响服务 */ }
    this.logger.log(`[审计] ${event}${fields && fields.detail ? ' ' + fields.detail : ''}`);
  }
}

/* ---------------------------------------------------------------- 设备台账 */

/**
 * devices.json：[{id,name,tokenHash,createdAt,lastSeenAt,revokedAt?}]
 * 令牌明文永不落盘；撤销即刻生效（内存+文件同步）；rotate/add 的明文只打印一次。
 */
class DeviceRegistry {
  constructor(file, logger) {
    this.file = file;
    this.logger = logger || { log: () => {} };
    this.devices = [];
    this.lastMtimeMs = -1; // 阶段 C 修复 A-22：CLI（另一进程）revoke/rotate 后运行中的桥接必须感知——按 mtime 热重载
    this.load();
  }

  load() {
    try {
      const stat = fs.statSync(this.file);
      this.lastMtimeMs = stat.mtimeMs;
      this.devices = JSON.parse(fs.readFileSync(this.file, 'utf8')).devices || [];
    } catch (err) {
      if (err.code === 'ENOENT') { this.lastMtimeMs = -1; this.devices = []; return; }
      throw new Error(`设备台账损坏（${err.message}）——拒绝启动，请人工检查 ${this.file}`);
    }
  }

  /** CLI 与服务是两个进程：每次认证前核对 mtime，外部变更（revoke/rotate/add）即刻生效。 */
  reloadIfChanged() {
    try {
      const m = fs.statSync(this.file).mtimeMs;
      if (m !== this.lastMtimeMs) this.load();
    } catch (_) { /* 文件短暂不可读：沿用内存态 */ }
  }

  persist() {
    fs.writeFileSync(this.file, JSON.stringify({ devices: this.devices }, null, 2), 'utf8');
    try { this.lastMtimeMs = fs.statSync(this.file).mtimeMs; } catch (_) { /* 尽力而为 */ }
  }

  /** 按明文令牌找活跃设备：对明文做一次哈希后与台账哈希常量时间比较（台账只存哈希，不可二次哈希）。 */
  findActive(provided) {
    if (typeof provided !== 'string' || provided.length === 0) return null;
    this.reloadIfChanged();
    const h = Buffer.from(sha256Hex(provided), 'hex');
    for (const d of this.devices) {
      if (d.revokedAt) continue;
      const b = Buffer.from(d.tokenHash, 'hex');
      if (h.length === b.length && crypto.timingSafeEqual(h, b)) return d;
    }
    return null;
  }

  add(name) {
    const token = randomToken();
    const device = {
      id: randomId(),
      name: String(name || `device-${randomId()}`).slice(0, 40),
      tokenHash: sha256Hex(token),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    };
    this.devices.push(device);
    this.persist();
    return { device, token };
  }

  revoke(id) {
    const d = this.devices.find((x) => x.id === id);
    if (!d) return null;
    if (!d.revokedAt) {
      d.revokedAt = new Date().toISOString();
      this.persist();
    }
    return d;
  }

  rotate(id) {
    const d = this.devices.find((x) => x.id === id && !x.revokedAt);
    if (!d) return null;
    const token = randomToken();
    d.tokenHash = sha256Hex(token);
    d.rotatedAt = new Date().toISOString();
    this.persist();
    return { device: d, token };
  }

  touch(id) {
    const d = this.devices.find((x) => x.id === id);
    if (d) {
      d.lastSeenAt = new Date().toISOString();
      // lastSeen 不逐次写盘（写放大），由 CLI 主动 save 时落盘
    }
  }

  saveSeen() {
    try { this.persist(); } catch (_) { /* 尽力而为 */ }
  }
}

/* ---------------------------------------------------------------- 认证与路径 */

/**
 * 设备解析：优先 devices 台账；无台账文件时回退到旧版单令牌配置（兼容既有部署与测试）。
 * 返回 { ok, device?, forwardPath?, reason? }。
 */
function authenticate(req, config, registry) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const firstSegment = url.pathname.split('/')[1] || '';
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

  let matched = null;
  let forwardPath = null;
  if (firstSegment && TOKEN_SEGMENT.test(firstSegment)) {
    if (registry) {
      matched = registry.findActive(firstSegment);
      if (matched) {
        const rest = url.pathname.slice(firstSegment.length + 1);
        forwardPath = rest + url.search; // rest 自带前导斜杠
      }
    } else if (tokenMatches(firstSegment, config.token)) {
      const rest = url.pathname.slice(firstSegment.length + 1);
      forwardPath = rest + url.search;
    }
    if (matched || (!registry && forwardPath !== null)) {
      return { ok: true, device: matched || null, forwardPath, tokenSource: 'path' };
    }
    // 路径令牌不匹配时立即失败，不回退到 Bearer（fail-closed，防多凭据通道混淆）
    return { ok: false, reason: 'token-mismatch' };
  }
  if (bearer) {
    if (registry) {
      matched = registry.findActive(bearer);
    } else if (tokenMatches(bearer, config.token)) {
      matched = { id: 'bearer', name: 'bearer' };
    }
    if (matched) {
      return { ok: true, device: matched, forwardPath: url.pathname + url.search, tokenSource: 'header' };
    }
    return { ok: false, reason: 'token-mismatch' };
  }
  return { ok: false, reason: 'token-missing' };
}

/** 日志脱敏：只输出路径（不含查询串），路径中的令牌段替换为 <token>。 */
function redactPath(forwardPath) {
  return forwardPath.split('?')[0].replace(/^\/[A-Za-z0-9_-]{32,128}(?=\/|$)/, '/<token>');
}

/* ---------------------------------------------------------------- 失败限速 */

/** 按源 IP 的认证失败滑动窗口限速：窗口内超限即临时封禁（内存态，重启即清）。 */
class RateLimiter {
  constructor(options) {
    this.windowMs = (options && options.windowMs) || 60_000;
    this.maxFailures = (options && options.maxAuthFailures) || 10;
    this.banMs = (options && options.banMs) || 300_000;
    this.failures = new Map(); // ip -> [timestamps]
    this.bannedUntil = new Map(); // ip -> until
  }

  isBanned(ip, now) {
    const until = this.bannedUntil.get(ip);
    if (until && until > (now || Date.now())) return true;
    if (until) this.bannedUntil.delete(ip);
    return false;
  }

  /** 记一次失败；达到阈值则封禁并返回 true。 */
  recordFailure(ip, now) {
    const t = now || Date.now();
    const list = (this.failures.get(ip) || []).filter((x) => t - x < this.windowMs);
    list.push(t);
    this.failures.set(ip, list);
    if (list.length >= this.maxFailures) {
      this.bannedUntil.set(ip, t + this.banMs);
      this.failures.delete(ip);
      return true;
    }
    return false;
  }
}

/* ---------------------------------------------------------------- 配置 */

function defaultConfigPath() {
  return path.join(__dirname, '桥接配置.json');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadConfig(configPath, logger) {
  const log = logger || { log: () => {} };
  if (!fs.existsSync(configPath)) {
    const registryFile = path.join(path.dirname(configPath), 'devices.json');
    const registry = new DeviceRegistry(registryFile, log);
    const { device, token } = registry.add('first-device');
    registry.saveSeen();
    const template = {
      listenHost: '127.0.0.1',
      listenPort: 3090,
      dshHost: '127.0.0.1',
      dshPort: 3080,
      tls: null, // { pfxPath } —— 配置后仅以 HTTPS 监听
      audit: { level: 'info', retentionDays: 30 },
      auditDir: path.join(path.dirname(configPath), '审计日志'),
      _说明: '设备令牌在 devices.json 中仅存哈希；add/rotate 的明文只打印一次。listenHost 改为局域网 IP 可让手机跨机访问（务必保留设备令牌）。tls 配置 {pfxPath} 后仅 HTTPS 监听（禁降级）。',
    };
    fs.writeFileSync(configPath, JSON.stringify(template, null, 2), 'utf8');
    log.log(`[配置] 未找到配置文件，已生成 ${configPath}`);
    log.log(`[设备] 已注册首台设备 ${device.id}（${device.name}），令牌只显示这一次：`);
    log.log(`[设备] ${token}`);
    return template;
  }
  const raw = readJson(configPath);
  const config = {
    listenHost: raw.listenHost || '127.0.0.1',
    listenPort: Number(raw.listenPort) || 3090,
    dshHost: raw.dshHost || '127.0.0.1',
    dshPort: Number(raw.dshPort) || 3080,
    tls: raw.tls || null,
    audit: raw.audit || { level: 'info', retentionDays: 30 },
    token: typeof raw.token === 'string' && raw.token ? raw.token : '',
  };
  // 旧版单令牌配置自动迁移为设备台账（原令牌成为 default 设备，可撤销/轮换）
  if (config.token) {
    const registryFile = path.join(path.dirname(configPath), 'devices.json');
    if (!fs.existsSync(registryFile)) {
      const registry = new DeviceRegistry(registryFile, log);
      const { device } = registry.add('default');
      device.tokenHash = sha256Hex(config.token); // 迁移：不再保存明文
      registry.persist();
      log.log(`[设备] 已将旧版单令牌迁移为设备 ${device.id}（default），devices.json 仅存哈希`);
    }
  }
  if (!config.token && !fs.existsSync(path.join(path.dirname(configPath), 'devices.json'))) {
    throw new Error('既无 token 也无 devices.json——拒绝启动（fail-closed）。请运行 devices add 注册设备。');
  }
  return config;
}

/* ---------------------------------------------------------------- 桥接服务 */

/**
 * 创建桥接服务（可注入 logger 便于测试）。
 * config: {listenHost,listenPort,dshHost,dshPort,token?,tls?,audit?}
 * registry: 可选 DeviceRegistry（设备台账模式）
 * @returns {{ server: http.Server, close: () => Promise<void>, registry?, rateLimiter, audit }}
 */
function createBridge(config, logger, registry) {
  const log = logger || { log: () => {} };
  const dshAuthority = `${config.dshHost}:${config.dshPort}`;
  const audit = new AuditLog(config.auditDir || path.join(__dirname, '审计日志'), config.audit, log);
  const rateLimiter = new RateLimiter(config.rateLimit);

  function clientIp(req) {
    return (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  function reject(res, status, text) {
    const body = JSON.stringify({ error: text });
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  /** 状态探测：仅证明 DSH 端口上有 HTTP 服务在应答（任何状态码都算 running）。 */
  function probeDsh() {
    return new Promise((resolve) => {
      const req = http.request(
        { host: config.dshHost, port: config.dshPort, path: '/', method: 'GET', timeout: 2000 },
        (res) => {
          res.resume();
          res.on('end', () => resolve('running'));
        }
      );
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', () => resolve('not_running'));
      req.end();
    });
  }

  async function handleStatus(req, res, auth) {
    const dsh = await probeDsh();
    if (auth.device) registry && registry.touch(auth.device.id);
    const body = JSON.stringify({
      bridge: 'running',
      bridgeVersion: VERSION,
      dsh,
      dshEndpoint: dshAuthority,
      tls: Boolean(config.tls),
      serverTime: new Date().toISOString(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  function forward(req, res) {
    const ip = clientIp(req);
    const auth = authenticate(req, config, registry);
    if (!auth.ok) {
      const banned = rateLimiter.recordFailure(ip);
      audit.write('warn', 'AUTH_FAIL', { detail: `${ip} 原因=${auth.reason}${banned ? ' 已临时封禁' : ''}` });
      reject(res, 401, 'unauthorized');
      return;
    }
    if (auth.device) registry && registry.touch(auth.device.id);
    if (auth.forwardPath === '/bridge/status' && req.method === 'GET') {
      audit.write('debug', 'STATUS', { detail: redactPath(auth.forwardPath) });
      handleStatus(req, res, auth);
      return;
    }
    const headers = { ...req.headers, host: dshAuthority };
    delete headers.authorization; // 桥接令牌不透传给 DSH
    const proxyReq = http.request(
      { host: config.dshHost, port: config.dshPort, method: req.method, path: auth.forwardPath, headers },
      (proxyRes) => {
        audit.write('debug', 'PROXY', { detail: `${req.method} ${redactPath(auth.forwardPath)} -> ${proxyRes.statusCode}` });
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', (err) => {
      // DSH 未启动等：如实回传 502 与原因，不伪造任何业务响应
      audit.write('warn', 'UPSTREAM_ERROR', { detail: `${req.method} ${redactPath(auth.forwardPath)} ${err.code || err.message}` });
      if (!res.headersSent) reject(res, 502, `dsh-unreachable: ${err.code || err.message}`);
      else res.destroy();
    });
    req.pipe(proxyReq);
  }

  function forwardUpgrade(req, clientSocket, head) {
    const ip = clientIp(req);
    const auth = authenticate(req, config, registry);
    if (!auth.ok) {
      const banned = rateLimiter.recordFailure(ip);
      audit.write('warn', 'UPGRADE_FAIL', { detail: `${ip} 原因=${auth.reason}${banned ? ' 已临时封禁' : ''}` });
      clientSocket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    if (rateLimiter.isBanned(ip)) {
      audit.write('warn', 'UPGRADE_BANNED', { detail: ip });
      clientSocket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const headers = { ...req.headers, host: dshAuthority };
    delete headers.authorization;
    const proxyReq = http.request({
      host: config.dshHost,
      port: config.dshPort,
      method: req.method,
      path: auth.forwardPath,
      headers,
    });
    proxyReq.end();
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      audit.write('debug', 'UPGRADE', { detail: `${redactPath(auth.forwardPath)} -> 101` });
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [k, v] of Object.entries(proxyRes.headers)) lines.push(`${k}: ${v}`);
      clientSocket.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) proxySocket.write(head);
      if (proxyHead && proxyHead.length) clientSocket.write(proxyHead);
      proxySocket.pipe(clientSocket);
      clientSocket.pipe(proxySocket);
      const teardown = () => { proxySocket.destroy(); clientSocket.destroy(); };
      proxySocket.on('error', teardown);
      clientSocket.on('error', teardown);
      proxySocket.on('close', teardown);
      clientSocket.on('close', teardown);
    });
    proxyReq.on('response', (res) => {
      audit.write('debug', 'UPGRADE_REJECTED', { detail: `${redactPath(auth.forwardPath)} -> ${res.statusCode}` });
      const statusLine = `HTTP/1.1 ${res.statusCode} ${res.statusMessage || ''}`;
      const headLines = [statusLine];
      for (const [k, v] of Object.entries(res.headers)) headLines.push(`${k}: ${v}`);
      clientSocket.write(headLines.join('\r\n') + '\r\n\r\n');
      res.resume();
      res.on('end', () => clientSocket.destroy());
    });
    proxyReq.on('error', (err) => {
      audit.write('warn', 'UPGRADE_ERROR', { detail: `${redactPath(auth.forwardPath)} ${err.code || err.message}` });
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
    });
  }

  const requestHandler = (req, res) => {
    const ip = clientIp(req);
    if (rateLimiter.isBanned(ip)) {
      audit.write('warn', 'REQUEST_BANNED', { detail: ip });
      reject(res, 429, 'temporarily banned');
      return;
    }
    forward(req, res);
  };

  let server;
  if (config.tls && config.tls.pfxPath) {
    const pfx = fs.readFileSync(config.tls.pfxPath);
    server = https.createServer({ pfx, passphrase: config.tls.passphrase || undefined }, requestHandler);
  } else {
    server = http.createServer(requestHandler);
  }
  server.on('upgrade', forwardUpgrade);

  return {
    server,
    audit,
    rateLimiter,
    registry: registry || null,
    /** 供测试/受控关闭使用 */
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/* ---------------------------------------------------------------- 设备管理 CLI */

function runDeviceCli(argv) {
  const configPath = defaultConfigPath();
  const registryFile = path.join(path.dirname(configPath), 'devices.json');
  const registry = new DeviceRegistry(registryFile);
  const [cmd, arg] = argv;
  if (cmd === 'list') {
    for (const d of registry.devices) {
      console.log(`${d.id}  ${d.name}${d.revokedAt ? '  [已撤销 ' + d.revokedAt + ']' : ''}  建于 ${d.createdAt}  最近活跃 ${d.lastSeenAt || '从未'}`);
    }
    if (!registry.devices.length) console.log('（无设备）');
    return 0;
  }
  if (cmd === 'add') {
    const { device, token } = registry.add(arg);
    console.log(`[设备] 已注册 ${device.id}（${device.name}）`);
    console.log(`[设备] 令牌只显示这一次：\n${token}`);
    console.log(`[设备] 手机端主机地址：http://<电脑IP>:<端口>/${token}`);
    return 0;
  }
  if (cmd === 'revoke') {
    const d = registry.revoke(arg);
    if (!d) { console.error(`未找到设备 ${arg}`); return 1; }
    console.log(`[设备] ${d.id}（${d.name}）已撤销——该设备的令牌即刻失效，活跃连接将在下一次请求时被拒。`);
    return 0;
  }
  if (cmd === 'rotate') {
    const r = registry.rotate(arg);
    if (!r) { console.error(`未找到可轮换的活跃设备 ${arg}`); return 1; }
    console.log(`[设备] ${r.device.id}（${r.device.name}）令牌已轮换，旧令牌即刻失效。`);
    console.log(`[设备] 新令牌只显示这一次：\n${r.token}`);
    return 0;
  }
  console.log('用法: node bridge.js devices list|add <名称>|revoke <设备id>|rotate <设备id>');
  return 1;
}

/* ---------------------------------------------------------------- 入口 */

function main() {
  // 设备管理 CLI：node bridge.js devices ...
  if (process.argv[2] === 'devices') {
    process.exit(runDeviceCli(process.argv.slice(3)));
  }
  const configPath = path.resolve(process.argv[2] || defaultConfigPath());
  const logger = { log: (m) => console.log(m) };
  let config;
  let registry = null;
  try {
    config = loadConfig(configPath, logger);
    const registryFile = path.join(path.dirname(configPath), 'devices.json');
    if (fs.existsSync(registryFile)) {
      registry = new DeviceRegistry(registryFile, logger);
      const active = registry.devices.filter((d) => !d.revokedAt).length;
      if (!active && !config.token) throw new Error('没有任何活跃设备且无旧版令牌——拒绝启动（fail-closed）。请用 devices add 注册设备。');
    }
  } catch (err) {
    console.error(`[致命] ${err.message}`);
    process.exit(2);
  }
  const { server, audit } = createBridge(config, logger, registry);
  audit.write('info', 'START', { detail: `v${VERSION} ${config.listenHost}:${config.listenPort} -> ${config.dshHost}:${config.dshPort}` });
  server.listen(config.listenPort, config.listenHost, () => {
    console.log(`[启动] dsh-bridge v${VERSION} 监听 ${config.listenHost}:${config.listenPort}${config.tls ? '（HTTPS，禁降级）' : ''}`);
    console.log(`[启动] 转发目标（仅出站）：http://${config.dshHost}:${config.dshPort}`);
    if (config.listenHost !== '127.0.0.1' && config.listenHost !== '::1' && config.listenHost !== 'localhost') {
      console.log(`[警告] 当前绑定非回环地址：局域网内任何设备都可触达本端口。`);
      console.log(`[警告] 网络可达≠授权：没有有效设备令牌的请求一律被拒绝；请勿将端口映射到公网。`);
    }
    if (config.tls && config.tls.pfxPath) {
      try {
        const der = crypto.X509Certificate ? new crypto.X509Certificate(fs.readFileSync(config.tls.pfxPath)) : null;
        if (der) console.log(`[TLS] 证书指纹(SHA-256)：${der.fingerprint256}——设备侧请核对后信任。`);
      } catch (_) { /* 指纹打印失败不影响服务 */ }
    }
    console.log(`[启动] 设备管理：node bridge.js devices list|add|revoke|rotate（本机执行）`);
    console.log(`[启动] 令牌不打印到任何日志；仅配置/台账文件与注册时可见。`);
  });
  const seenSaver = setInterval(() => registry && registry.saveSeen(), 60_000);
  seenSaver.unref();
  const shutdown = () => {
    audit.write('info', 'STOP', {});
    console.log('[停止] 收到退出信号，正在关闭…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = {
  createBridge,
  loadConfig,
  tokenMatches,
  authenticate,
  redactPath,
  randomToken,
  sha256Hex,
  DeviceRegistry,
  RateLimiter,
  AuditLog,
  VERSION,
};
