param(
    [ValidateSet('install', 'compile', 'test', 'demo', 'node', 'deploy:testnet', 'verify:deployment')]
    [string]$Task = 'test',
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$TaskArguments
)

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $taskTempPath = Join-Path $PSScriptRoot '.local\tmp'
    New-Item -ItemType Directory -Path $taskTempPath -Force | Out-Null
    $env:TEMP = $taskTempPath
    $env:TMP = $taskTempPath
    $env:NODE_DISABLE_COMPILE_CACHE = '1'
    if ($Task -eq 'install') {
        & npm.cmd ci
    } else {
        & npm.cmd run $Task -- @TaskArguments
    }
    if ($LASTEXITCODE -ne 0) { throw "Contracts task failed: $Task (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}
