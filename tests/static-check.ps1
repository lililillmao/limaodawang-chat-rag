param(
    [string]$Root,
    [switch]$Quiet
)

# Limao AI Toolbox - static checks
# 1) per-file syntax  2) duplicate top-level decls  3) merged syntax  4) python syntax
# NOTE: this file is ASCII-only on purpose. Windows PowerShell 5.1 reads .ps1 as GBK when
# there is no UTF-8 BOM, so non-ASCII literals written by UTF-8-only editors get corrupted.
# -Root defaults to this script's parent directory (i.e. the project root).
if (-not $Root) {
    $Root = Split-Path -Parent $PSScriptRoot
    if (-not $Root) { $Root = (Get-Location).Path }
}

$ErrorActionPreference = "Continue"
$fail = 0
$NL = [Environment]::NewLine

function Say($text, $color) {
    if ($Quiet) { return }
    if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

$html = Get-Content -LiteralPath (Join-Path $Root "index.html") -Raw -Encoding UTF8
$order = @()
foreach ($m in [regex]::Matches($html, '<script\s+src="(js/[^"]+)"')) { $order += $m.Groups[1].Value }

if ($order.Count -eq 0) { Write-Host "!! no js/*.js order parsed from index.html" -ForegroundColor Red; exit 1 }

Say "=== 1. per-file syntax ===" Cyan
foreach ($rel in $order) {
    $full = Join-Path $Root ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full)) { Say "  MISSING $rel" Red; $fail++; continue }
    $out = & node --check $full 2>&1
    if ($LASTEXITCODE -eq 0) { Say "  OK   $rel" }
    else { Say "  FAIL $rel" Red; Say ($out -join $NL); $fail++ }
}
Say ("  modules: " + $order.Count)

Say ($NL + "=== 2. duplicate top-level declarations ===") Cyan
$decls = @{}
$pattern = '^(let|const|var|function|class)\s+([A-Za-z_$][\w$]*)'
foreach ($rel in $order) {
    $full = Join-Path $Root ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full)) { continue }
    $hits = Select-String -LiteralPath $full -Pattern $pattern -AllMatches
    foreach ($h in $hits) {
        $name = $h.Matches[0].Groups[2].Value
        if (-not $decls.ContainsKey($name)) { $decls[$name] = @() }
        $decls[$name] = $decls[$name] + ($rel + ":" + $h.LineNumber)
    }
}
$dups = @()
foreach ($k in ($decls.Keys | Sort-Object)) {
    if ($decls[$k].Count -gt 1) { $dups += ($k + "  ->  " + ($decls[$k] -join ', ')) }
}
if ($dups.Count -gt 0) {
    foreach ($d in $dups) { Say ("  DUP  " + $d) Red; $fail++ }
} else {
    Say "  none"
}

Say ($NL + "=== 3. merged syntax (load order) ===") Cyan
$merged = Join-Path $env:TEMP "limao_merged_check.js"
$sb = New-Object System.Text.StringBuilder
foreach ($rel in $order) {
    $full = Join-Path $Root ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full)) { continue }
    [void]$sb.AppendLine("// ==== $rel ====")
    [void]$sb.AppendLine((Get-Content -LiteralPath $full -Raw -Encoding UTF8))
}
[System.IO.File]::WriteAllText($merged, $sb.ToString(), (New-Object System.Text.UTF8Encoding($false)))
$out = & node --check $merged 2>&1
if ($LASTEXITCODE -eq 0) { Say "  OK   merged bundle parses clean" }
else { Say "  FAIL merged conflict:" Red; Say ($out -join $NL); $fail++ }

Say ($NL + "=== 4. python syntax ===") Cyan
$py = Join-Path $Root "rag_server.py"
$pyCode = "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf-8').read()); print('  OK   rag_server.py')"
& python -c $pyCode $py
if ($LASTEXITCODE -ne 0) { $fail++ }

Say ""
if ($fail -eq 0) { Say "ALL CHECKS PASSED" Green } else { Say ("FAILURES: " + $fail) Red }
exit $fail
