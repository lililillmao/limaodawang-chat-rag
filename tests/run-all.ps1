param(
    [string]$Root = ""
)

# Limao AI Toolbox - test runner (ASCII only on purpose: Windows PowerShell 5.1
# reads .ps1 as GBK when a file has no UTF-8 BOM, which corrupts non-ASCII literals.)
#
# Runs, in order:
#   1. static checks (per-file syntax, duplicate top-level declarations, merged parse, python syntax)
#   2. tools module tests          (tool registry, safe calculator, tool-call accumulation, multimodal bodies)
#   3. importer module tests        (ChatGPT / Claude parsing, tree backtrace, cycles, hidden messages)
#   4. integration smoke test       (loads all modules in index.html order, runs init(), checks old + new APIs)
#   5. backend regression tests     (split_text guard, watchdog ignore regex, skill name, /api/emoji, memory ids)

$ErrorActionPreference = "Continue"
if (-not $Root) {
    $Root = Split-Path -Parent $PSScriptRoot
    if (-not $Root) { $Root = (Get-Location).Path }
}

function Say($t, $c) { if ($c) { Write-Host $t -ForegroundColor $c } else { Write-Host $t } }

Say ("Project: " + $Root) Cyan
Say ""

$failed = 0

# ---------- 1. static checks ----------
$staticScript = Join-Path $PSScriptRoot "static-check.ps1"
if (Test-Path -LiteralPath $staticScript) {
    Say "########## 1/5  static checks ##########" Cyan
    & $staticScript -Root $Root
    if ($LASTEXITCODE -ne 0) { $failed++ }
    Say ""
} else {
    Say "!! static-check.ps1 not found next to this runner" Red
    $failed++
}

# ---------- 2..4 node based suites ----------
$suites = @(
    @{ name = "2/5  tools module";     file = "test_tools.js";       args = @((Join-Path $Root "js\features\tools.js"), (Join-Path $Root "js\api.js")) },
    @{ name = "3/5  importer module";  file = "test_importer.js";    args = @((Join-Path $Root "js\features\importer.js")) },
    @{ name = "4/5  integration";      file = "test_integration.js"; args = @($Root) }
)

foreach ($s in $suites) {
    $script = Join-Path $PSScriptRoot $s.file
    Say ("########## " + $s.name + " ##########") Cyan
    if (-not (Test-Path -LiteralPath $script)) { Say ("!! missing: " + $script) Red; $failed++; continue }
    $nodeArgs = @($script) + $s.args
    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) { $failed++ }
    Say ""
}

# ---------- 5. backend (python) ----------
$backend = Join-Path $PSScriptRoot "test_backend.py"
Say "########## 5/5  backend regression ##########" Cyan
if (-not (Test-Path -LiteralPath $backend)) {
    Say ("!! missing: " + $backend) Red
    $failed++
} else {
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) {
        Say "!! python not found, skipping backend tests" Yellow
    } else {
        $prevEnc = $env:PYTHONIOENCODING
        $env:PYTHONIOENCODING = "utf-8"
        # 2>$null: this module prints Chinese warnings (e.g. embedding unavailable
        # without Ollama) on stderr; they are expected and would otherwise be
        # surfaced as PowerShell NativeCommandError noise.
        & python $backend $Root 2>$null
        if ($LASTEXITCODE -ne 0) { $failed++ }
        $env:PYTHONIOENCODING = $prevEnc
    }
    Say ""
}

Say ("=" * 56)
if ($failed -eq 0) { Say "ALL SUITES PASSED" Green } else { Say ("SUITES FAILED: " + $failed) Red }
exit $failed
