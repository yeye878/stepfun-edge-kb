# e2e/launch-chrome.ps1 — 在「沙箱外」的普通终端里启动带 CDP 端口的 Chrome，供 agent 侧 e2e attach 使用
#
# 背景：本机 agent 沙箱禁止创建命名管道，Chromium 的 Mojo IPC 无法初始化，
#       所以 agent 内无法启动任何 Chromium 浏览器（Chrome/Edge 都会在 100ms 内自杀）。
#       请在人类自己的 PowerShell（或评审机普通终端）运行本脚本。
#
# 用法：
#   pwsh -File e2e/launch-chrome.ps1                 # 默认端口 19222（headed 有窗口，方便观察）
#   pwsh -File e2e/launch-chrome.ps1 -Port 19223
#   pwsh -File e2e/launch-chrome.ps1 -Headless       # 无窗口（截图仍可用）
#   pwsh -File e2e/launch-chrome.ps1 -ProfileName cdp-e2e
#
# 注意：Chrome 156 已忽略 --disable-features=WebGPU（实测仍返回硬件 adapter）。
#       WASM 降级环境不需要第二个 Chrome：e2e/run.mjs --env wasm 会在页面脚本前用 CDP 注入隐藏 navigator.gpu。
param(
  [int]$Port = 19222,
  [string]$ProfileName = 'chrome-profile-cdp-webgpu',
  [switch]$Headless
)
$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { throw "Chrome 不存在: $chrome" }
$root = Split-Path -Parent $PSCommandPath
$profile = Join-Path $root ("out\" + $ProfileName)
New-Item -ItemType Directory -Force -Path $profile | Out-Null
$chromeArgs = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$profile",
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1440,900',
  '--hide-scrollbars'
)
if ($Headless) { $chromeArgs += '--headless=new' }
Start-Process -FilePath $chrome -ArgumentList $chromeArgs | Out-Null
$deadline = (Get-Date).AddSeconds(40)
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-RestMethod -Uri ("http://127.0.0.1:$Port/json/version") -TimeoutSec 2
    Write-Output ("READY " + $r.Browser + "  CDP=http://127.0.0.1:" + $Port)
    Write-Output ''
    Write-Output '接下来在 agent 侧运行：'
    Write-Output ("  node e2e/probe-browser.mjs --cdp-url http://127.0.0.1:" + $Port)
    Write-Output ("  node e2e/run.mjs --env webgpu --cdp-url http://127.0.0.1:" + $Port)
    Write-Output ("  node e2e/run.mjs --env wasm  --cdp-url http://127.0.0.1:" + $Port)
    exit 0
  } catch { Start-Sleep -Milliseconds 300 }
}
Write-Output ("FAILED: 40s 内 CDP 端口 " + $Port + " 未就绪")
exit 1
