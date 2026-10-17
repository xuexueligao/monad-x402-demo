param([ValidateSet('register','me','projects')][string]$Task='me')
$ErrorActionPreference='Stop'
$taskProjectRoot=Split-Path -Parent $PSScriptRoot
$taskLocalRoot=Join-Path $taskProjectRoot '.local'
$taskMetaPath=Join-Path $taskLocalRoot 'mojo-agent.json'
$taskSecretPath=Join-Path $taskLocalRoot 'mojo-agent.secret.dpapi'
$taskApiRoot='https://mojo.devnads.com'
$taskUtf8=New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Path $taskLocalRoot -Force | Out-Null

try {
  if ($Task -eq 'register') {
    if ((Test-Path -LiteralPath $taskMetaPath) -and (Test-Path -LiteralPath $taskSecretPath)) {
      $taskMeta=[System.IO.File]::ReadAllText($taskMetaPath,$taskUtf8) | ConvertFrom-Json
      [PSCustomObject]@{reused=$true;agentId=$taskMeta.agentId;name=$taskMeta.name;claimUrl=$taskMeta.claimUrl} | ConvertTo-Json -Compress
      exit 0
    }
    $taskName='Monad x402 Builder'
    $taskBody=@{name=$taskName;description='Builds and validates a Monad testnet x402 demo for Monad Blitz.'} | ConvertTo-Json -Compress
    $taskResponse=Invoke-WebRequest -Uri ($taskApiRoot+'/api/agent/register') -Method Post -ContentType 'application/json; charset=utf-8' -Body $taskUtf8.GetBytes($taskBody) -UseBasicParsing -MaximumRedirection 0
    $taskPayload=$taskResponse.Content | ConvertFrom-Json
    if (-not $taskPayload.success -or -not $taskPayload.data.agentSecret) { throw 'Registration did not return a usable agent credential.' }
    $taskSecure=ConvertTo-SecureString -String $taskPayload.data.agentSecret -AsPlainText -Force
    $taskEncrypted=ConvertFrom-SecureString -SecureString $taskSecure
    [System.IO.File]::WriteAllText($taskSecretPath,$taskEncrypted,$taskUtf8)
    $taskClaimUri=[Uri]$taskPayload.data.claimUrl
    if ($taskClaimUri.Scheme -ne 'https' -or $taskClaimUri.Host -ne 'mojo.devnads.com') { throw 'Unexpected claim URL host. Agent credential has been saved locally.' }
    $taskMeta=@{agentId=$taskPayload.data.agentId;name=$taskName;claimUrl=$taskPayload.data.claimUrl;eventId=17;registeredAt=[DateTime]::UtcNow.ToString('o')}
    [System.IO.File]::WriteAllText($taskMetaPath,($taskMeta | ConvertTo-Json -Depth 4),$taskUtf8)
    [PSCustomObject]@{status=$taskResponse.StatusCode;agentId=$taskMeta.agentId;name=$taskMeta.name;claimUrl=$taskMeta.claimUrl;credentialStorage='Windows DPAPI CurrentUser, git-ignored .local directory'} | ConvertTo-Json -Compress
    exit 0
  }

  if (-not (Test-Path -LiteralPath $taskSecretPath)) { throw 'No saved Mojo agent credential. Run the register task first.' }
  $taskSecure=ConvertTo-SecureString -String ([System.IO.File]::ReadAllText($taskSecretPath,$taskUtf8))
  $taskCredential=New-Object System.Management.Automation.PSCredential('mojo-agent',$taskSecure)
  $taskHeaders=@{Authorization='Bearer '+$taskCredential.GetNetworkCredential().Password}
  $taskPath=if ($Task -eq 'me') { '/api/agent/me' } else { '/api/agent/projects?eventId=17' }
  $taskResponse=Invoke-RestMethod -Uri ($taskApiRoot+$taskPath) -Method Get -Headers $taskHeaders -MaximumRedirection 0
  if ($Task -eq 'me') {
    $taskUser=if ($taskResponse.data.claimedUser) { @{id=$taskResponse.data.claimedUser.id;name=$taskResponse.data.claimedUser.name} } else { $null }
    $taskResponse=@{success=$taskResponse.success;data=@{agent=$taskResponse.data.agent;claimedUser=$taskUser}}
  }
  $taskOutput=$taskResponse | ConvertTo-Json -Depth 12
  $taskOutput=$taskOutput -replace 'mojo_agent_[A-Za-z0-9_-]+','[REDACTED]'
  $taskOutput
  exit 0
} catch {
  $taskStatus=if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
  $taskMessage=$_.Exception.Message -replace 'mojo_agent_[A-Za-z0-9_-]+','[REDACTED]'
  [PSCustomObject]@{status=$taskStatus;error=$taskMessage} | ConvertTo-Json -Compress
  exit 1
} finally {
  $taskHeaders=$null
  $taskCredential=$null
  $taskPayload=$null
  $taskSecure=$null
  $taskEncrypted=$null
}
