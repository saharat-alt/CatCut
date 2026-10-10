# Runs the headless AE smoke test. Refuses to run while any AE process is open,
# because AfterFX.exe -r would otherwise hand the script to the running GUI instance.
$ae = "C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe"
$busy = Get-Process -Name AfterFX, AfterFX.com, aerender -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host "After Effects/aerender is running (PIDs: $($busy.Id -join ', ')). Close it first."
    exit 1
}
$out = "D:\EDITMCP\tests\out"
New-Item -ItemType Directory -Force $out | Out-Null
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $ae -ArgumentList '-noui', '-r', 'D:\EDITMCP\tests\noui_smoke.jsx' -PassThru
if (-not $p.WaitForExit(300000)) { Write-Host "Timed out after 5 min (PID $($p.Id) still running)"; exit 2 }
Write-Host "AE exited with code $($p.ExitCode) after $([int]$sw.Elapsed.TotalSeconds)s"
if (Test-Path "$out\noui_smoke.json") { Get-Content "$out\noui_smoke.json" -Encoding UTF8 } else { Write-Host "No result JSON written" }
