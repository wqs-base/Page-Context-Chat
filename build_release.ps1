#!/usr/bin/env pwsh
# 一键生成分发产物：
#   skills\page-context-chat\scripts\page-context-chat-server.exe   本地服务可执行文件（技能自带，随技能分发）
#   release\page-context-chat-extension.zip                         Chrome 扩展打包（zip 根目录即 manifest.json 等）
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
$skillScriptsDir = Join-Path -Path $root -ChildPath "skills\page-context-chat\scripts"
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

# 2. 复制可执行文件到技能脚本目录（start_server.ps1 优先从这里取 exe）。
New-Item -ItemType Directory -Path $skillScriptsDir -Force | Out-Null
Copy-Item -LiteralPath $builtExe -Destination (Join-Path -Path $skillScriptsDir -ChildPath $exeName) -Force

# 兼容旧位置：若 release 下还残留同名 exe，清理掉以免混淆。
$legacyExe = Join-Path -Path $releaseDir -ChildPath $exeName
if (Test-Path -LiteralPath $legacyExe) {
    Remove-Item -LiteralPath $legacyExe -Force
}

# 3. 打包 Chrome 扩展。
$zipPath = Join-Path -Path $releaseDir -ChildPath $zipName
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path -Path $extensionDir -ChildPath "*") -DestinationPath $zipPath -Force

Write-Host ""
Write-Host "构建产物:"
foreach ($file in @((Join-Path -Path $skillScriptsDir -ChildPath $exeName), $zipPath)) {
    if (Test-Path -LiteralPath $file) {
        "{0}  ({1} MB)" -f $file, [math]::Round((Get-Item -LiteralPath $file).Length / 1MB, 2)
    }
}
