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

$serverDir = $PSScriptRoot
$projectRoot = Split-Path -Parent $serverDir
$specFile = Join-Path $serverDir "page_context_chat_server.spec"
$distDir = Join-Path $serverDir "dist"
$workDir = Join-Path $serverDir "build"
$exeName = "page-context-chat-server.exe"

Push-Location $projectRoot
# PyInstaller 会把日志写到 stderr；Windows PowerShell 在 ErrorActionPreference=Stop
# 下会把原生命令的 stderr 视为终止性错误，因此这里临时放开，改用退出码判断结果。
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

$exe = Join-Path $distDir $exeName
if (-not (Test-Path $exe)) {
    throw "未找到构建产物: $exe"
}

$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host "构建完成: $exe ($sizeMb MB)"
