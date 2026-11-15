# 给单个文件做 Authenticode 签名（Tauri 的 signCommand 会拿这个脚本当签名器）。
#
# 之所以自己写一个而不是用 Tauri 自带的 certificateThumbprint：
# 自带那条路要求 signtool 在 PATH 里，而这台机器装的是 Windows SDK 10.0.26100，
# signtool 只在带版本号的目录下，没进 PATH。这里自己找，省得改系统环境变量。
#
# 没有配置证书时**不报错**（exit 0），只打一行日志：
# 这样没证书的机器照样能出安装包，签名是「有就签、没有就跳过」的加分项，
# 不该把整个构建卡住。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign.ps1 <文件>
#
# 证书来源（按顺序）：
#   1. 环境变量 FY_SIGN_THUMBPRINT
#   2. scripts/sign.env.json 里的 { "thumbprint": "..." }
#   3. 都没有 → 跳过

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$File
)

$ErrorActionPreference = 'Stop'

function Find-SignTool {
  $kits = 'C:\Program Files (x86)\Windows Kits\10\bin'
  if (Test-Path $kits) {
    $found = Get-ChildItem $kits -Directory |
      Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
      Sort-Object { [version]$_.Name } -Descending |
      ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
    if ($found) { return $found }
  }
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$thumb = $env:FY_SIGN_THUMBPRINT
if (-not $thumb) {
  $cfg = Join-Path $PSScriptRoot 'sign.env.json'
  if (Test-Path $cfg) {
    $thumb = (Get-Content $cfg -Raw | ConvertFrom-Json).thumbprint
  }
}

if (-not $thumb) {
  Write-Host "[sign] 未配置证书，跳过签名：$File"
  exit 0
}

$signtool = Find-SignTool
if (-not $signtool) {
  Write-Host "[sign] 找不到 signtool.exe，跳过签名：$File"
  exit 0
}

# 时间戳让签名在证书过期后依然有效。网络不通就退回不盖章，签名本身不受影响。
$ts = 'http://timestamp.digicert.com'

Write-Host "[sign] $File"
& $signtool sign /sha1 $thumb /fd SHA256 /tr $ts /td SHA256 $File
if ($LASTEXITCODE -ne 0) {
  Write-Host '[sign] 带时间戳失败，改为不盖时间戳重试'
  & $signtool sign /sha1 $thumb /fd SHA256 $File
  if ($LASTEXITCODE -ne 0) {
    Write-Error "[sign] 签名失败：$File（exit $LASTEXITCODE）"
    exit 1
  }
}

# 自签证书不在受信任根里，verify /pa 必然报「证书链未受信任」——
# 那是证书的信任问题，不是签名没写进去。这里只把状态打出来，不让 verify 的
# 退出码把整个构建判成失败（NativeCommandError 会绕过 $LASTEXITCODE 直接抛）。
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$out = (& $signtool verify /pa $File 2>&1 | Out-String).Trim()
$ErrorActionPreference = $prev
if ($out -match 'Successfully verified') {
  Write-Host '[sign] 签名校验通过'
} else {
  Write-Host '[sign] 签名已写入（自签证书链未受信任，属预期）'
}
exit 0
