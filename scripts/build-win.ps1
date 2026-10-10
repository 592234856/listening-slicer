# Windows 一键打包脚本
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$app = Join-Path $root 'app'
$nodeDir = "$env:USERPROFILE\.local\share\node"
$env:PATH = "$nodeDir;$env:PATH"

# 准备内置 uv（打包后首次运行环境引导用）
$uvSrc = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
$uvDir = Join-Path $root 'assets\uv'
if (-not (Test-Path $uvSrc)) {
    throw "未找到 uv.exe（$uvSrc）。请先安装 uv，或手动复制到 assets\uv\uv.exe"
}
New-Item -ItemType Directory -Force -Path $uvDir | Out-Null
Copy-Item $uvSrc (Join-Path $uvDir 'uv.exe') -Force
Write-Host "已内置 uv: $(Join-Path $uvDir 'uv.exe')" -ForegroundColor DarkGray

Write-Host '[1/2] 构建渲染进程与主进程...' -ForegroundColor Cyan
Push-Location $app
try {
    & "$nodeDir\npm.cmd" run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build 失败' }

    Write-Host '[2/2] electron-builder 打包 Windows (nsis x64)...' -ForegroundColor Cyan
    & "$nodeDir\npx.cmd" electron-builder --win --x64
    if ($LASTEXITCODE -ne 0) { throw 'electron-builder 失败' }
} finally {
    Pop-Location
}
Write-Host "完成。产物在 $app\release\" -ForegroundColor Green
