#!/bin/bash
# macOS 一键打包脚本：在 Mac 终端执行 ./scripts/build-mac.sh
# 产物在 app/release/*.dmg（Intel x64 + Apple Silicon arm64 各一份）
set -e
cd "$(dirname "$0")/.."

# 依赖检查：Node 18+ 与 npm
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js 18+（brew install node 或官网安装包）" >&2
  exit 1
fi

cd app
echo "[1/2] 构建渲染进程与主进程..."
npm install
npm run build

echo "[2/2] electron-builder 打包 macOS (dmg x64 + arm64)..."
# 无签名证书：跳过签名与公证检查（安装时需右键打开绕过 Gatekeeper）
export CSC_IDENTITY_AUTO_DISCOVERY=false
npx electron-builder --mac

echo "完成。产物在 app/release/"
