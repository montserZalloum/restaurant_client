#requires -Version 5.1
[CmdletBinding()]
param(
  [ValidateSet('preparing','ready','delivered','cancelled','cleared')]
  [string]$Status = 'preparing',
  [string]$OrderId,
  [int]$OrderNumber,
  [string]$EventId,
  [string]$ApiKey,
  [string]$BaseUrl,
  [int]$Times = 1
)

$ErrorActionPreference = 'Stop'

$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'config\config.json'
if (Test-Path $configPath) {
  $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
  if (-not $ApiKey)  { $ApiKey  = $cfg.restaurant.api_key }
  if (-not $BaseUrl) { $BaseUrl = $cfg.cloud.base_url }
}
if (-not $ApiKey)  { throw "ApiKey not provided and not found in $configPath" }
if (-not $BaseUrl) { throw "BaseUrl not provided and not found in $configPath" }

$rankMap = @{ preparing = 1; ready = 2; delivered = 3; cancelled = 99; cleared = 99 }
$hasOrderNum = $PSBoundParameters.ContainsKey('OrderNumber')

for ($i = 1; $i -le $Times; $i++) {
  $eid = if ($EventId)     { $EventId }     else { "evt_" + [guid]::NewGuid().ToString("N").Substring(0,12) }
  $oid = if ($OrderId)     { $OrderId }     else { [guid]::NewGuid().ToString() }
  $num = if ($hasOrderNum) { $OrderNumber } else { Get-Random -Min 1 -Max 999 }

  $body = @{
    events = @(@{
      event_id     = $eid
      order_id     = $oid
      order_number = $num
      status       = $Status
      status_rank  = $rankMap[$Status]
      extracted    = $true
      at           = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
      source       = 'local'
    })
  } | ConvertTo-Json -Depth 5 -Compress

  Write-Host "POST $BaseUrl/api/orders/events  ($Status #$num)" -ForegroundColor Cyan
  Write-Host "  $body" -ForegroundColor DarkGray
  try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/api/orders/events" `
      -Method Post `
      -Headers @{ Authorization = "Bearer $ApiKey" } `
      -ContentType 'application/json' `
      -Body $body
    $rej = if ($resp.rejected) { $resp.rejected.Count } else { 0 }
    Write-Host "  -> accepted=$($resp.accepted -join ',') rejected=$rej" -ForegroundColor Green
  } catch {
    Write-Host "  -> ERROR: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Response) {
      $r = $_.Exception.Response
      $reader = New-Object System.IO.StreamReader($r.GetResponseStream())
      Write-Host "  -> body: $($reader.ReadToEnd())" -ForegroundColor Red
    }
  }
}
