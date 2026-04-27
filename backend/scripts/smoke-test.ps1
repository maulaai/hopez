$b = 'http://localhost:3011'
$ErrorActionPreference = 'Stop'
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession

function Call($path, $method = 'GET', $body = $null) {
  $p = @{ Uri = "$b$path"; Method = $method; WebSession = $s }
  if ($body) { $p.ContentType = 'application/json'; $p.Body = $body }
  try {
    $r = Invoke-WebRequest @p
    return "$($r.StatusCode) $($r.Content)"
  } catch {
    $resp = $_.Exception.Response
    $code = if ($resp) { $resp.StatusCode.value__ } else { 'NA' }
    return "ERR $code $($_.ErrorDetails.Message)"
  }
}

Write-Host "signup:    " (Call '/api/auth/signup' 'POST' '{"email":"u2@x.com","password":"password123"}')
Write-Host "me:        " (Call '/api/auth/me')
Write-Host "plans:     " (Call '/api/auth/plans')
Write-Host "key1:      " (Call '/api/auth/keys' 'POST' '{"name":"prod"}')
Write-Host "key2(403): " (Call '/api/auth/keys' 'POST' '{"name":"second"}')
Write-Host "checkout:  " (Call '/api/auth/checkout' 'POST' '{"plan_id":"starter"}')
Write-Host "key2 ok:   " (Call '/api/auth/keys' 'POST' '{"name":"second"}')
Write-Host "payments:  " (Call '/api/auth/payments')
Write-Host "forgot:    " (Call '/api/auth/forgot' 'POST' '{"email":"u2@x.com"}')
Write-Host "bad reset: " (Call '/api/auth/reset' 'POST' '{"token":"bogus","password":"newpass123"}')
