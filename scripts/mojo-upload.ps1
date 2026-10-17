$ErrorActionPreference='Stop'
$taskProjectRoot=Split-Path -Parent $PSScriptRoot
$taskLocalRoot=Join-Path $taskProjectRoot '.local'
$taskImagePath=Join-Path $taskLocalRoot 'evidence\browser-paid.png'
$taskUploadRecord=Join-Path $taskLocalRoot 'mojo-upload.json'
$taskSecretPath=Join-Path $taskLocalRoot 'mojo-agent.secret.dpapi'
$taskApiRoot='https://mojo.devnads.com'
$taskUtf8=New-Object System.Text.UTF8Encoding($false)

try {
  if (Test-Path -LiteralPath $taskUploadRecord) {
    $taskExisting=[System.IO.File]::ReadAllText($taskUploadRecord,$taskUtf8) | ConvertFrom-Json
    if ($taskExisting.confirmed -eq $true) { [PSCustomObject]@{reused=$true;uuid=$taskExisting.uuid;path=$taskExisting.path;confirmed=$true} | ConvertTo-Json -Compress; exit 0 }
  }
  $taskImage=Get-Item -LiteralPath $taskImagePath
  if ($taskImage.Length -gt 10MB) { throw 'Screenshot exceeds Mojo upload limit.' }
  $taskSecure=ConvertTo-SecureString -String ([System.IO.File]::ReadAllText($taskSecretPath,$taskUtf8))
  $taskCredential=New-Object System.Management.Automation.PSCredential('mojo-agent',$taskSecure)
  $taskHeaders=@{Authorization='Bearer '+$taskCredential.GetNetworkCredential().Password}
  $taskBody=@{filename='monad-x402-payment-demo.png';contentType='image/png';size=$taskImage.Length} | ConvertTo-Json -Compress
  $taskAllocation=Invoke-RestMethod -Uri ($taskApiRoot+'/api/agent/uploads') -Method Post -Headers $taskHeaders -ContentType 'application/json; charset=utf-8' -Body $taskUtf8.GetBytes($taskBody) -MaximumRedirection 0
  if (-not $taskAllocation.success -or -not $taskAllocation.data.uuid -or -not $taskAllocation.data.uploadUrl) { throw 'Upload allocation failed.' }
  $taskUploadUri=[Uri]$taskAllocation.data.uploadUrl
  if ($taskUploadUri.Scheme -ne 'https') { throw 'Upload URL must use HTTPS.' }
  # Do not forward the Mojo Authorization header to object storage.
  $taskUploaded=Invoke-WebRequest -Uri $taskUploadUri -Method Put -ContentType 'image/png' -InFile $taskImagePath -UseBasicParsing -MaximumRedirection 0
  if ($taskUploaded.StatusCode -lt 200 -or $taskUploaded.StatusCode -ge 300) { throw 'Object storage upload failed.' }
  $taskConfirmBody=@{uuid=$taskAllocation.data.uuid} | ConvertTo-Json -Compress
  $taskConfirmed=Invoke-RestMethod -Uri ($taskApiRoot+'/api/agent/uploads/confirm') -Method Post -Headers $taskHeaders -ContentType 'application/json; charset=utf-8' -Body $taskUtf8.GetBytes($taskConfirmBody) -MaximumRedirection 0
  if (-not $taskConfirmed.success) { throw 'Mojo did not confirm the screenshot upload.' }
  $taskRecord=@{uuid=$taskAllocation.data.uuid;path=$taskAllocation.data.path;confirmed=$true;filename=$taskImage.Name;sha256=(Get-FileHash -LiteralPath $taskImagePath -Algorithm SHA256).Hash;confirmedAt=[DateTime]::UtcNow.ToString('o')}
  [System.IO.File]::WriteAllText($taskUploadRecord,($taskRecord | ConvertTo-Json -Depth 5),$taskUtf8)
  [PSCustomObject]@{uuid=$taskRecord.uuid;path=$taskRecord.path;confirmed=$true;imageSize=$taskImage.Length} | ConvertTo-Json -Compress
} catch {
  $taskStatus=if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
  [PSCustomObject]@{status=$taskStatus;error='Screenshot upload did not complete. Temporary upload URL and credentials are withheld.'} | ConvertTo-Json -Compress
  exit 1
} finally {
  $taskHeaders=$null
  $taskCredential=$null
  $taskSecure=$null
  $taskAllocation=$null
}
