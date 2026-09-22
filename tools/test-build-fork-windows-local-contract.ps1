$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptPath = Join-Path $PSScriptRoot "build-fork-windows-local.ps1"
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "Local Windows build helper is missing: $scriptPath"
}

$content = Get-Content -LiteralPath $scriptPath -Raw

$requiredSnippets = @(
    "OSVersion.Platform",
    "Python 3.11 is required",
    "22.22.2",
    'CIBW_BUILD = "cp310-*"',
    'CIBW_ARCHS_WINDOWS = "AMD64"',
    "python -m cibuildwheel --output-dir electron-src/assets/python",
    "node scripts/smoke-test-wheel.mjs",
    "cargo build --release --manifest-path GSM_Overlay/input_server/Cargo.toml",
    "npm ci --prefer-offline --no-audit --fund=false",
    "npm run package",
    "npx vitest run electron-src/main/services/game_provisioning_command.test.ts --config vitest.config.ts",
    "npm run build:native",
    "npm run build",
    "npm run build:windows-helpers",
    "npm run stage:overlay",
    "npx electron-builder --publish=never --win",
    "npm run verify:overlay-package",
    "Compress-Archive",
    'builder = "local-windows"',
    'signed = $false'
)

foreach ($snippet in $requiredSnippets) {
    if (-not $content.Contains($snippet)) {
        throw "Local Windows build helper drifted from the expected build contract; missing: $snippet"
    }
}

if (-not $content.Contains("originalTemplateBytes")) {
    throw "Expected local builder to restore temporarily normalized overlay templates."
}

if (-not $content.Contains('local-build-$commit')) {
    throw "Expected commit-addressed local artifact directory."
}

Write-Host "local Windows build helper contract test passed."
