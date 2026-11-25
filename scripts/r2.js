// scripts/r2.js - R2 上传与 manifest（零依赖，S3 兼容 API + SigV4）
//
// 为什么自己签 SigV4 而不装 aws-sdk / minio：本项目坚持零第三方依赖；
// R2 暴露 S3 兼容 API，PUT/HEAD/DELETE 一个对象只需要一次 HMAC-SHA256 签名。
//
// 环境变量（README / .env.example 有完整说明）：
//   CF_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_BUCKET · R2_PUBLIC_BASE_URL
//
// 用法（一般由 publish-r2.js 调用，不直接跑）：
//   const { uploadFile, headObject, publicUrl } = require('./r2')
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REQUIRED = ['CF_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

function readConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !String(env[k] || '').trim());
  if (missing.length) {
    const err = new Error(
      `缺少 R2 环境变量：${missing.join(', ')}\n` +
        '请把 .env.example 中对应项填进仓库根 .env（已被 gitignore）。',
    );
    err.code = 'ENV_MISSING';
    throw err;
  }
  return {
    accountId: env.CF_ACCOUNT_ID.trim(),
    accessKeyId: env.R2_ACCESS_KEY_ID.trim(),
    secretAccessKey: env.R2_SECRET_ACCESS_KEY.trim(),
    bucket: env.R2_BUCKET.trim(),
    publicBaseUrl: String(env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
  };
}

// ---------- 基础工具 ----------

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function amzDate(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20261125T120000Z
  return { long: iso, short: iso.slice(0, 8) };
}

/** 把对象键按 S3 规则编码：保留 '/'，其余段做 percent-encode */
function encodeKey(key) {
  return String(key)
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

// ---------- SigV4 纯签名（与 R2 解耦，可用 AWS 官方向量验证） ----------

/**
 * @param {{accessKeyId:string, secretAccessKey:string}} cfg
 * @param {string} method
 * @param {string} canonicalUri 已编码的路径（含前导 /）
 * @param {string} canonicalQuery 已排序编码的查询串（无则空串）
 * @param {Record<string,string>} headers 参与签名的头（含 host / x-amz-date）
 * @param {Date} now
 * @param {{region:string, service:string}} opts
 */
function awsSign(cfg, method, canonicalUri, canonicalQuery, headers, now, opts) {
  const { long, short } = amzDate(now);
  const { region, service } = opts;
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim();
  const sortedNames = Object.keys(lower).sort();

  const canonicalHeaders = sortedNames.map((h) => `${h}:${lower[h]}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  // AWS 规范：第 6 行是 payload 的 SHA-256。调用方通过 x-amz-content-sha256 传入；
  // 没有这个头时按空 body 计算（GET/HEAD 常见）。
  const payloadHash = lower['x-amz-content-sha256'] || sha256Hex(Buffer.alloc(0));

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join(
    '\n',
  );
  const scope = `${short}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', long, scope, sha256Hex(Buffer.from(canonicalRequest))].join('\n');

  const kDate = hmac('AWS4' + cfg.secretAccessKey, short);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    _debug: { canonicalRequest, stringToSign, signature, signedHeaders },
  };
}

/**
 * 生成 R2 请求
 * R2 的 S3 兼容端点是 **path-style**：https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
 * @param {object} cfg  readConfig() 的返回值
 * @param {string} method  PUT | HEAD | GET | DELETE
 * @param {string} key     对象键
 * @param {Buffer} [body]  请求体（PUT 时有）
 * @param {Record<string,string>} [extraHeaders]
 * @param {Date} [now]
 */
function signRequest(cfg, method, key, body = Buffer.alloc(0), extraHeaders = {}, now = new Date()) {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  // path-style：桶名必须在路径里
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const headers = {
    host,
    'x-amz-content-sha256': sha256Hex(body),
    'x-amz-date': amzDate(now).long,
    ...extraHeaders,
  };
  const { authorization, _debug } = awsSign(cfg, method, canonicalUri, '', headers, now, {
    region: 'auto',
    service: 's3',
  });
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim();

  return {
    url: `https://${host}${canonicalUri}`,
    headers: { ...lower, Authorization: authorization },
    _debug,
  };
}

// ---------- 对象操作 ----------

/** 上传一个文件；contentType 不传时按扩展名猜 */
async function uploadFile(cfg, key, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  const type = contentType || guessType(filePath);
  const { url, headers } = signRequest(cfg, 'PUT', key, body, { 'content-type': type });
  const res = await fetch(url, { method: 'PUT', headers, body });
  if (!res.ok) {
    throw new Error(`R2 PUT ${key} 失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return { key, bytes: body.length, contentType: type };
}

/** 上传 Buffer（用于 latest.json） */
async function uploadBuffer(cfg, key, buf, contentType = 'application/json') {
  const { url, headers } = signRequest(cfg, 'PUT', key, buf, { 'content-type': contentType });
  const res = await fetch(url, { method: 'PUT', headers, body: buf });
  if (!res.ok) {
    throw new Error(`R2 PUT ${key} 失败 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return { key, bytes: buf.length, contentType };
}

/** HEAD 一个对象，存在返回 { size, etag }，不存在返回 null */
async function headObject(cfg, key) {
  const { url, headers } = signRequest(cfg, 'HEAD', key);
  const res = await fetch(url, { method: 'HEAD', headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 HEAD ${key} 失败 HTTP ${res.status}`);
  return { size: Number(res.headers.get('content-length') || 0), etag: res.headers.get('etag') || '' };
}

/** 删除对象；不存在视为成功（幂等） */
async function deleteObject(cfg, key) {
  const { url, headers } = signRequest(cfg, 'DELETE', key);
  const res = await fetch(url, { method: 'DELETE', headers });
  if (res.status !== 204 && res.status !== 404) {
    throw new Error(`R2 DELETE ${key} 失败 HTTP ${res.status}`);
  }
}

/** 公开访问地址（自定义域 / r2.dev）；未配置时返回 null */
function publicUrl(cfg, key) {
  if (!cfg.publicBaseUrl) return null;
  return `${cfg.publicBaseUrl}/${encodeKey(key)}`;
}

const TYPES = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.blockmap': 'application/octet-stream',
  '.yml': 'text/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.dmg': 'application/x-apple-diskimage',
  '.zip': 'application/zip',
};

function guessType(filePath) {
  return TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

module.exports = {
  readConfig,
  awsSign,
  signRequest,
  uploadFile,
  uploadBuffer,
  headObject,
  deleteObject,
  publicUrl,
  guessType,
  sha256Hex,
  encodeKey,
};
