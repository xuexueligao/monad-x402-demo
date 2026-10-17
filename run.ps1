param([string]$Task='dev:arena')
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskTempPath=Join-Path $PSScriptRoot '.local\tmp'
New-Item -ItemType Directory -Path $taskTempPath -Force | Out-Null
$env:TEMP=$taskTempPath
$env:TMP=$taskTempPath
$env:NODE_DISABLE_COMPILE_CACHE='1'
$env:NEXT_TELEMETRY_DISABLED='1'
if ($Task -eq 'install') { & npm.cmd install --no-audit --no-fund } else { & npm.cmd run $Task }
exit $LASTEXITCODE
