# web/dev/run-integration.ps1 — 单次前台调用内完成「起真实后端 → 浏览器冒烟 → 关后端」
#
# 为什么要在同一个前台调用里做：本机沙箱会在 pwsh 工具调用结束时回收其子进程，
# 所以后端必须在同一次调用中启动、使用、关闭；Chrome 由沙箱外进程启动（CDP attach）。
#
# 用法：
#   pwsh -File web/dev/run-integration.ps1                     # 真实 seekdb + WebGPU 路径
#   pwsh -File web/dev/run-integration.ps1 -NoWebGpu           # 模拟 WebGPU 不可用 → WASM 降级路径
#   pwsh -File web/dev/run-integration.ps1 -Bench int8-wasm    # 附带跑一个评测配置
param(
  [switch]$NoWebGpu,
  [string]$Bench = '',
  [string]$CdpUrl = 'http://127.0.0.1:19223',
  [string]$PageUrl = 'http://127.0.0.1:18271/',
  [string]$DbPath = '',
  [int]$ServerPort = 18270
)
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent (Split-Path -Parent $PSCommandPath)   # src/
$logs = Join-Path (Split-Path -Parent $src) 'outputs\logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
if (-not $DbPath) { $DbPath = 'D:\oceanbase\_scratch\t27\webui-seekdb' }

$serverOut = Join-Path $logs '2026-10-31_web-real-server.log'
$serverErr = Join-Path $logs '2026-10-31_web-real-server.err.log'
Remove-Item $serverOut, $serverErr -ErrorAction SilentlyContinue

$env:SEEKDB_BINDINGS_CACHE_DIR = 'D:\oceanbase\_scratch\t27\bindings'
$env:SEEKDB_PATH = $DbPath
$env:PORT = "$ServerPort"
$env:STEPKB_SHIM_QUIET = '1'

Write-Output ('[integration] 启动真实后端（seekdb embedded, path=' + $DbPath + '）')
$proc = Start-Process -FilePath 'node' -ArgumentList 'server\index.mjs' -WorkingDirectory $src -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr -PassThru -WindowStyle Hidden
$ready = $false
$deadline = (Get-Date).AddSeconds(75)
while ((Get-Date) -lt $deadline) {
  try {
    $h = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $ServerPort + "/api/health") -TimeoutSec 2
    $ready = $true
    Write-Output ('[integration] 后端就绪：' + $h.dbVersion + ' mode=' + $h.dbMode + ' openMs=' + $h.openMs)
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ready) {
  Write-Output '[integration] 后端 75s 内未就绪，输出日志：'
  Get-Content $serverOut -ErrorAction SilentlyContinue | Select-Object -Last 40 | Out-String
  Get-Content $serverErr -ErrorAction SilentlyContinue | Select-Object -Last 40 | Out-String
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  exit 20
}

$smokeArgs = @('web\dev\smoke.mjs', '--url', $PageUrl, '--cdp-url', $CdpUrl)
if ($NoWebGpu) { $smokeArgs += '--no-webgpu' }
if ($Bench) { $smokeArgs += @('--bench', $Bench) }
Write-Output ('[integration] 运行浏览器冒烟：node ' + ($smokeArgs -join ' '))
& node @smokeArgs
$smokeExit = $LASTEXITCODE

Write-Output ('[integration] 冒烟退出码=' + $smokeExit + '，关闭后端')
try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 500
Write-Output '=== 后端日志（尾部）==='
Get-Content $serverOut -ErrorAction SilentlyContinue | Select-Object -Last 30 | Out-String
if (Test-Path $serverErr) { Get-Content $serverErr -ErrorAction SilentlyContinue | Select-Object -Last 10 | Out-String }
exit $smokeExit
