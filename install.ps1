# CatCut installer for Windows: Node, ffmpeg, CatCut itself, then Claude Code and/or Codex.
# Run in PowerShell:  irm https://raw.githubusercontent.com/thefogusz/CatCut/main/install.ps1 | iex
# Running it again updates CatCut. Nothing here needs git or coding.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Repo = 'thefogusz/CatCut'
$Ref = if ($env:CATCUT_REF) { $env:CATCUT_REF } else { 'main' }
$Root = if ($env:CATCUT_HOME) { $env:CATCUT_HOME } else { Join-Path $env:LOCALAPPDATA 'CatCut' }
$App = Join-Path $Root 'app'

function Say($th, $en) { Write-Host "  $th" -ForegroundColor Cyan; if ($en) { Write-Host "  $en" -ForegroundColor DarkGray } }
function Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
# Native tools may write progress to stderr; never let that abort the installer.
function Run($exe) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $exe @args 2>&1 | ForEach-Object { "$_" } | Out-Host; return $LASTEXITCODE } finally { $ErrorActionPreference = $old }
}
function Toml-Str($s) { '"' + ($s -replace '\\', '\\' -replace '"', '\"') + '"' }
function Winget-Install($id) {
  if (-not (Has winget)) { throw "ไม่พบ winget — อัปเดต 'App Installer' จาก Microsoft Store แล้วลองใหม่ / winget missing: update 'App Installer' from the Microsoft Store" }
  Run winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements | Out-Null
  Refresh-Path
}

Write-Host ''
Write-Host '  CatCut  =^.^=  ติดตั้ง / install' -ForegroundColor Magenta
Write-Host ''

# 1. Node.js 22+
$nodeOk = $false
if (Has node) { $nodeOk = [int]((node -v) -replace '^v(\d+).*', '$1') -ge 22 }
if (-not $nodeOk) { Say 'กำลังติดตั้ง Node.js ...' 'Installing Node.js LTS'; Winget-Install 'OpenJS.NodeJS.LTS' }
if (-not (Has node)) { throw 'ติดตั้ง Node.js ไม่สำเร็จ ปิดแล้วเปิด PowerShell ใหม่ แล้วรันคำสั่งเดิมอีกครั้ง / Node.js not found: reopen PowerShell and run again' }
$Node = (Get-Command node).Source
Ok "Node $(node -v)"

# 2. ffmpeg (CatCut also finds the winget install folder without PATH)
$ffWinget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
$hasFf = (Has ffmpeg) -or [bool](Get-ChildItem $ffWinget -Filter 'Gyan.FFmpeg*' -Directory -ErrorAction SilentlyContinue)
if (-not $hasFf) { Say 'กำลังติดตั้ง ffmpeg ...' 'Installing ffmpeg'; Winget-Install 'Gyan.FFmpeg.Essentials' }
Ok 'ffmpeg'

# 3. CatCut: download, unpack next to the old copy, then swap (old copy kept until the swap succeeds)
Say 'กำลังดาวน์โหลด CatCut ...' 'Downloading CatCut'
New-Item -ItemType Directory -Force $Root | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$zip = Join-Path $env:TEMP "catcut-$stamp.zip"
$unpack = Join-Path $Root "new-$stamp"
Invoke-WebRequest "https://github.com/$Repo/archive/refs/heads/$Ref.zip" -OutFile $zip -UseBasicParsing
Expand-Archive $zip -DestinationPath $unpack
Remove-Item $zip -Force
$src = Get-ChildItem $unpack -Directory | Select-Object -First 1
$bundle = Join-Path $src.FullName 'dist\bundle\catcut.mjs'
if (-not (Test-Path $bundle)) { throw 'ไฟล์ CatCut ไม่ครบ / download is missing dist/bundle/catcut.mjs' }
if (Test-Path $App) {
  try { Rename-Item $App "app-old-$stamp" }
  catch { Remove-Item $unpack -Recurse -Force; throw 'CatCut ตัวเก่ากำลังถูกใช้อยู่ ปิด Claude / Codex ก่อน แล้วรันใหม่ / CatCut is in use: close Claude and Codex, then run again' }
}
Move-Item $src.FullName $App
Remove-Item $unpack -Recurse -Force
Get-ChildItem $Root -Directory -Filter 'app-old-*' | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$Bundle = Join-Path $App 'dist\bundle\catcut.mjs'
Ok "CatCut -> $App"

# 4. Claude Code: the plugin brings the MCP server, skill and /catcut:* commands
$claudeDone = $false
if (Has claude) {
  Run claude plugin marketplace add $Repo | Out-Null      # fails harmlessly when already added
  Run claude plugin marketplace update catcut | Out-Null
  if ((Run claude plugin install 'catcut@catcut') -eq 0) { $claudeDone = $true; Ok 'Claude Code plugin' }
  else { Warn 'Claude Code: ติดตั้งปลั๊กอินอัตโนมัติไม่ได้ ทำตามขั้นด้านล่าง / plugin install failed, see below' }
}

# 5. Codex: MCP server entry + skill (backups kept next to the originals)
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$codexDone = $false
if (Test-Path $codexDir) {
  $cfg = Join-Path $codexDir 'config.toml'
  $block = @('[mcp_servers.catcut]', "command = $(Toml-Str $Node)", "args = [$(Toml-Str $Bundle), ""serve""]")
  $lines = @()
  if (Test-Path $cfg) {
    Copy-Item $cfg "$cfg.bak-catcut-$stamp"
    $skip = $false
    foreach ($l in (Get-Content $cfg -Encoding UTF8)) {
      if ($l -match '^\s*\[') { $skip = $l -match '^\s*\[mcp_servers\.catcut(\.[^\]]+)?\]\s*$' }
      if (-not $skip) { $lines += $l }
    }
  }
  $lines += ''; $lines += $block
  [IO.File]::WriteAllLines($cfg, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
  $skillDir = Join-Path $codexDir 'skills\catcut-editor'
  New-Item -ItemType Directory -Force $skillDir | Out-Null
  $skill = Join-Path $skillDir 'SKILL.md'
  if (Test-Path $skill) { Copy-Item $skill "$skill.bak-$stamp" }
  Copy-Item (Join-Path $App 'skills\catcut-editor\SKILL.md') $skill -Force
  $codexDone = $true
  Ok 'Codex (config.toml + skill)'
}

# 6. Check
Write-Host ''
& $Node $Bundle doctor | Out-Host
Write-Host ''
Say 'เสร็จแล้ว!' 'Done.'
if ($codexDone) { Say 'Codex: ปิดแล้วเปิด Codex ใหม่ แล้วพิมพ์ เช่น "ใช้ CatCut ทำเอฟเฟคหัวใจนีออน 6 วิ"' }
if ($claudeDone) { Say 'Claude Code: เปิดใหม่ แล้วพิมพ์ /catcut:motion หัวใจนีออน 6 วิ' }
else {
  Say 'Claude (แอป Claude แท็บ Code หรือ Claude Code): พิมพ์ 2 บรรทัดนี้ในแชท ครั้งเดียวพอ' 'In Claude Code, paste these two lines once:'
  Write-Host '    /plugin marketplace add thefogusz/CatCut' -ForegroundColor White
  Write-Host '    /plugin install catcut@catcut' -ForegroundColor White
}
Say 'อยากอัปเดต: รันคำสั่งติดตั้งเดิมอีกครั้ง' 'To update, run the same install command again.'
Write-Host ''
