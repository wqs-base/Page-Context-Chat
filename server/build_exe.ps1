#!/usr/bin/env pwsh
# 使用 PyInstaller 将本地服务打包为独立可执行文件。
#
# 用法：
#   pwsh -File .\server\build_exe.ps1
#   pwsh -File .\server\build_exe.ps1 -Python "D:\miniforge3\envs\agent\python.exe"
#
# 产物：server\dist\page-context-chat-server.exe

param(
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"

$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $serverDir
$specFile = Join-Path $serverDir "page_context_chat_server.spec"
$distDir = Join-Path $serverDir "dist"
$workDir = Join-Path $serverDir "build"

Push-Location $projectRoot
try {
    & $Python -m PyInstaller `
        --noconfirm `
        --clean `
        --distpath $distDir `
        --workpath $workDir `
        $specFile
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller 构建失败，退出码 $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$exe = Join-Path $distDir "page-context-chat-server.exe"
if (-not (Test-Path $exe)) {
    throw "未找到构建产物: $exe"
}

$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "构建完成: $exe ($sizeMb MB)"
