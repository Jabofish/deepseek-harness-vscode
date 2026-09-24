'use strict'

// VS Code 1.139 自带的 js-debug 在附加 localhost 目标时会同时探测 127.0.0.1 和
// [::1]（src/extension.js 里的 Uq）。扩展主机的 inspector 只绑定 IPv4，[::1] 必然
// ECONNREFUSED，而组合器 Ai 把任意一个失败当作整体失败，于是 F5 调试扩展时附加
// 直接中止，扩展主机永远停在第 1 行（表现为“扩展未在 10 秒内启动”）。
//
// 本脚本把探测改成：单个地址失败只淘汰该地址，两个地址都失败时仍然抛错，
// 从而保留 js-debug 原本的“目标还没起来就重试”语义。
//
//   node scripts/patch-js-debug-ipv6-probe.cjs            打补丁（自动查找安装位置）
//   node scripts/patch-js-debug-ipv6-probe.cjs --restore  还原备份
//   node scripts/patch-js-debug-ipv6-probe.cjs <path>     指定 extension.js 路径
//
// VS Code 更新会整体替换安装目录，补丁随之失效，需要重新执行本脚本并重载窗口。

const fs = require('node:fs')
const path = require('node:path')

const probeOriginal =
  'try{let a;return await Ai([i,o].map(async u=>(a=await r.fetchJson(u,s.token),a.ok&&a)))||a}finally{s.cancel()}'
const probePatched =
  'try{let a,f,v=await Ai([i,o].map(async u=>{try{a=await r.fetchJson(u,s.token)}catch(e){f??=e;return}return a.ok&&a}));if(v)return v;if(f)throw f;return a}finally{s.cancel()}'
const probePatchedMarker = 'try{let a,f,v=await Ai('
const backupSuffix = '.dsh-orig'

/**
 * @param {string[]} files
 * @param {string} candidate
 */
function pushIfFile(files, candidate) {
  if (fs.existsSync(candidate) && !files.includes(candidate)) files.push(candidate)
}

/**
 * @param {string[]} files
 * @param {string} directory
 * @param {number} depth
 */
function scanDirectory(files, directory, depth) {
  if (depth === 0 || !fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const child = path.join(directory, entry.name)
    pushIfFile(
      files,
      path.join(child, 'resources', 'app', 'extensions', 'ms-vscode.js-debug', 'src', 'extension.js'),
    )
    pushIfFile(files, path.join(child, 'src', 'extension.js'))
    scanDirectory(files, child, depth - 1)
  }
}

/** @returns {string[]} */
function installedBundles() {
  /** @type {string[]} */
  const files = []
  const home = process.env.USERPROFILE ?? process.env.HOME
  /** @type {string[]} */
  const bases = []
  if (process.platform === 'win32' && process.env.LOCALAPPDATA !== undefined)
    bases.push(path.join(process.env.LOCALAPPDATA, 'Programs'))
  if (process.platform === 'darwin') bases.push('/Applications')
  if (process.platform === 'linux') bases.push('/usr/share', '/usr/lib')
  for (const base of bases) scanDirectory(files, base, 3)
  if (home !== undefined) {
    for (const profile of ['.vscode', '.vscode-insiders'])
      scanDirectory(files, path.join(home, profile, 'extensions'), 1)
  }
  return files
}

/** @param {string} file */
function patchBundle(file) {
  const source = fs.readFileSync(file, 'utf8')
  if (source.includes(probePatchedMarker)) {
    console.log(`already patched: ${file}`)
    return
  }
  if (!source.includes(probeOriginal)) {
    console.error(`unrecognized js-debug bundle, left untouched: ${file}`)
    process.exitCode = 1
    return
  }
  fs.writeFileSync(`${file}${backupSuffix}`, source)
  fs.writeFileSync(file, source.replace(probeOriginal, probePatched))
  console.log(`patched: ${file}`)
  console.log(`backup:  ${file}${backupSuffix}`)
}

/** @param {string} file */
function restoreBundle(file) {
  const backup = `${file}${backupSuffix}`
  if (!fs.existsSync(backup)) {
    console.error(`no backup next to ${file}`)
    process.exitCode = 1
    return
  }
  fs.copyFileSync(backup, file)
  console.log(`restored: ${file}`)
}

const arguments_ = process.argv.slice(2)
const restore = arguments_.includes('--restore')
const explicitPaths = arguments_.filter((argument) => argument !== '--restore')
const bundles = explicitPaths.length > 0 ? explicitPaths : installedBundles()

if (bundles.length === 0) {
  console.error('No js-debug extension.js found. Pass its path explicitly.')
  process.exitCode = 1
} else {
  for (const bundle of bundles) {
    if (restore) restoreBundle(bundle)
    else patchBundle(bundle)
  }
  if (process.exitCode !== 1 && !restore)
    console.log('Reload the VS Code window (Developer: Reload Window) so the patched debugger is loaded.')
}
