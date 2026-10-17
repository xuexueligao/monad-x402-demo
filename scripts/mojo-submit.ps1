$ErrorActionPreference='Stop'
$taskProjectRoot=Split-Path -Parent $PSScriptRoot
$taskLocalRoot=Join-Path $taskProjectRoot '.local'
$taskUtf8=New-Object System.Text.UTF8Encoding($false)
$taskApiRoot='https://mojo.devnads.com'
$taskPayloadPath=Join-Path $taskLocalRoot 'mojo-submission.json'
$taskRecordPath=Join-Path $taskLocalRoot 'mojo-project.json'

try {
  $taskSecure=ConvertTo-SecureString -String ([System.IO.File]::ReadAllText((Join-Path $taskLocalRoot 'mojo-agent.secret.dpapi'),$taskUtf8))
  $taskCredential=New-Object System.Management.Automation.PSCredential('mojo-agent',$taskSecure)
  $taskHeaders=@{Authorization='Bearer '+$taskCredential.GetNetworkCredential().Password}
  $taskMe=Invoke-RestMethod -Uri ($taskApiRoot+'/api/agent/me') -Method Get -Headers $taskHeaders -MaximumRedirection 0
  if ($taskMe.data.agent.status -ne 'claimed' -or -not $taskMe.data.claimedUser) { throw 'Mojo agent is not bound to a user.' }
  $taskExisting=Invoke-RestMethod -Uri ($taskApiRoot+'/api/agent/projects?eventId=17') -Method Get -Headers $taskHeaders -MaximumRedirection 0
  $taskJson=[System.IO.File]::ReadAllText($taskPayloadPath,$taskUtf8)
  $taskSubmission=$taskJson | ConvertFrom-Json
  if ($taskSubmission.eventId -ne 17) { throw 'Unexpected submission event.' }
  $taskUpload=[System.IO.File]::ReadAllText((Join-Path $taskLocalRoot 'mojo-upload.json'),$taskUtf8) | ConvertFrom-Json
  if (-not $taskUpload.confirmed -or $taskSubmission.meta.screenshots[0].uuid -ne $taskUpload.uuid) { throw 'Submission must reference our confirmed screenshot.' }
  if ($taskExisting.data.project) {
    if (-not (Test-Path -LiteralPath $taskRecordPath)) { throw 'A project now exists. Inspect it before deciding whether to update it.' }
    $taskSaved=[System.IO.File]::ReadAllText($taskRecordPath,$taskUtf8) | ConvertFrom-Json
    if ($taskSaved.projectId -ne $taskExisting.data.project.id) { throw 'Existing project differs from our saved submission.' }
    $taskMethod='PATCH'
    $taskPath='/api/agent/projects/'+$taskExisting.data.project.id
    $taskSubmission.PSObject.Properties.Remove('eventId')
    $taskJson=$taskSubmission | ConvertTo-Json -Depth 8
  } else {
    $taskMethod='POST'
    $taskPath='/api/agent/projects'
  }
  $taskResponse=Invoke-WebRequest -Uri ($taskApiRoot+$taskPath) -Method $taskMethod -Headers $taskHeaders -ContentType 'application/json; charset=utf-8' -Body $taskUtf8.GetBytes($taskJson) -UseBasicParsing -MaximumRedirection 0
  $taskResult=$taskResponse.Content | ConvertFrom-Json
  if (-not $taskResult.success) { throw 'Mojo did not confirm successful project submission.' }
  $taskReadback=Invoke-RestMethod -Uri ($taskApiRoot+'/api/agent/projects?eventId=17') -Method Get -Headers $taskHeaders -MaximumRedirection 0
  if (-not $taskReadback.data.project) { throw 'Submission response was successful but project readback is empty.' }
  $taskProject=$taskReadback.data.project
  $taskRecord=@{projectId=$taskProject.id;eventId=17;submittedAt=[DateTime]::UtcNow.ToString('o');method=$taskMethod;responseStatus=$taskResponse.StatusCode;project=$taskProject}
  [System.IO.File]::WriteAllText($taskRecordPath,($taskRecord | ConvertTo-Json -Depth 12),$taskUtf8)
  [PSCustomObject]@{responseStatus=$taskResponse.StatusCode;projectId=$taskProject.id;project=$taskProject} | ConvertTo-Json -Depth 12
  exit 0
} catch {
  $taskStatus=if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { $null }
  $taskError=$_.Exception.Message -replace 'mojo_agent_[A-Za-z0-9_-]+','[REDACTED]'
  $taskDetails=$null
  if ($_.ErrorDetails.Message) {
    try {
      $taskParsed=$_.ErrorDetails.Message | ConvertFrom-Json
      $taskDetails=@{message=$taskParsed.message;error=$taskParsed.error;fieldErrors=$taskParsed.fieldErrors}
    } catch {}
  }
  [PSCustomObject]@{status=$taskStatus;error=$taskError;details=$taskDetails} | ConvertTo-Json -Depth 8
  exit 1
} finally {
  $taskHeaders=$null
  $taskCredential=$null
  $taskSecure=$null
}
