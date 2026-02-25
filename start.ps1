#!/usr/bin/env pwsh
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = $PSScriptRoot

# ── Build ─────────────────────────────────────────────────────────────────────
Write-Host "Building WASM..." -ForegroundColor Cyan
Push-Location $ProjectRoot
wasm-pack build --target web --out-dir www/pkg
Pop-Location

# ── Serve ─────────────────────────────────────────────────────────────────────
$Port = 8080
$Url  = "http://localhost:$Port"

Write-Host "Serving at $Url  (Ctrl+C to stop)" -ForegroundColor Green
Start-Process $Url   # open browser

Push-Location "$ProjectRoot/www"
python -m http.server $Port
Pop-Location
