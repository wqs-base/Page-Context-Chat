#!/usr/bin/env pwsh
# 一键生成 release 目录下的分发产物：
#   release\page-context-chat-server.exe       本地服务可执行文件（PyInstaller 构建）
#   release\page-context-chat-extension.zip    Chrome 扩展打包（zip 根目录即 manifest.json 等）
#
# 用法：
#   pwsh -File .\build_release.ps1
#   pwsh -File .\build_release.ps1 -Python "D:\miniforge3\envs\agent\python.exe"
#
# 注意：本文件必须保存为 UTF-8 带 BOM。Windows PowerShell 5.1 会把无 BOM 的
# UTF-8 当成系统 ANSI 代码页读取，中文注释可能吞掉下一行代码。

param(
    [string]$Python = "python"
)

$root = $PSScriptRoot
if (-not $root) {
    $root = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$serverDir = Join-Path -Path $root -ChildPath "server"
$extensionDir = Join-Path -Path $root -ChildPath "extension"
$releaseDir = Join-Path -Path $root -ChildPath "release"
$specFile = Join-Path -Path $serverDir -ChildPath "page_context_chat_server.spec"
$distDir = Join-Path -Path $serverDir -ChildPath "dist"
$workDir = Join-Path -Path $serverDir -ChildPath "build"
$exeName = "page-context-chat-server.exe"
$zipName = "page-context-chat-extension.zip"

Write-Host "项目根目录: $root"
Write-Host "Python:     $Python"

New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null

# 1. 构建服务端可执行文件（输出到 server\dist）。
#    PyInstaller 会把日志写到 stderr，这里临时放开 ErrorActionPreference，改用退出码判断。
Push-Location $root
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    & $Python -m PyInstaller --noconfirm --clean --distpath $distDir --workpath $workDir $specFile
    $exitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousPreference
    Pop-Location
}
if ($exitCode -ne 0) {
    throw "PyInstaller 构建失败，退出码 $exitCode"
}

$builtExe = Join-Path -Path $distDir -ChildPath $exeName
if (-not (Test-Path -LiteralPath $builtExe)) {
    throw "未找到构建产物: $builtExe"
}

# 2. 复制到 release。
Copy-Item -LiteralPath $builtExe -Destination (Join-Path -Path $releaseDir -ChildPath $exeName) -Force

# 3. 打包 Chrome 扩展。
$zipPath = Join-Path -Path $releaseDir -ChildPath $zipName
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path -Path $extensionDir -ChildPath "*") -DestinationPath $zipPath -Force

Write-Host ""
Write-Host "release 目录已更新:"
Get-ChildItem -LiteralPath $releaseDir | ForEach-Object {
    "{0}  ({1} MB)" -f $_.Name, [math]::Round($_.Length / 1MB, 2)
}
