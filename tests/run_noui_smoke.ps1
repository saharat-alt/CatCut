# Runs the headless AE smoke test in a separate instance (-m) and keeps all output under <repo>\tmp.
# Refuses to run while any AE process is open, so a script can never reach a user's GUI session.
$ErrorActionPreference = 'Stop'
$ae = "C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe"
$busy = Get-Process -Name AfterFX, AfterFX.com, aerender -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host "After Effects/aerender is running (PIDs: $($busy.Id -join ', ')). Close it first."
    exit 1
}
$repo = Split-Path -Parent $PSScriptRoot
$out = Join-Path $repo ("tmp\noui-smoke-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $out | Out-Null
# noui_smoke.jsx hardcodes its output folder; run a copy that writes into $out instead.
$outJsx = ($out -replace '\\', '/') + '/'
$script = Join-Path $out 'noui_smoke.jsx'
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'noui_smoke.jsx'), [Text.Encoding]::UTF8)
[IO.File]::WriteAllText($script, $source.Replace('D:/EDITMCP/tests/out/', $outJsx), (New-Object Text.UTF8Encoding $false))
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $ae -ArgumentList '-m', '-noui', '-r', "`"$script`"" -PassThru
if (-not $p.WaitForExit(300000)) {
    & taskkill /T /F /PID $p.Id | Out-Null
    Write-Host "Timed out after 5 min (process tree $($p.Id) killed)"
    exit 2
}
Write-Host "AE exited with code $($p.ExitCode) after $([int]$sw.Elapsed.TotalSeconds)s; output in $out"
$json = Join-Path $out 'noui_smoke.json'
if (Test-Path $json) { Get-Content $json -Encoding UTF8 } else { Write-Host "No result JSON written" }
