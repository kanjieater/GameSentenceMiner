param(
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $repoRoot "dist"
$wheelDir = Join-Path $repoRoot "electron-src\assets\python"
$overlayTemplateDir = Join-Path $repoRoot "GSM_Overlay\yomitan\data\templates"
$originalTemplateBytes = @{}

function Require-Command([string]$Name, [string]$Hint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command '$Name'. $Hint"
    }
}

function Invoke-Checked([string]$Label, [scriptblock]$Command) {
    Write-Host ""
    Write-Host "=== $Label ===" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    throw "This builder must run in Windows PowerShell/pwsh on the Windows host. WSL2/Linux Docker cannot produce the supported GSM Windows package."
}

Require-Command "git" "Install Git for Windows."
Require-Command "python" "Install Python 3.11 and make it available as 'python'."
Require-Command "node" "Install Node.js 22.22.2 or newer."
Require-Command "npm" "npm is installed with Node.js."
Require-Command "npx" "npx is installed with npm."
Require-Command "cargo" "Install Rust with the MSVC Windows toolchain."
Require-Command "rustc" "Install Rust with the MSVC Windows toolchain."

Push-Location $repoRoot
try {
    $nodeVersionText = (& node --version).Trim().TrimStart("v")
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read Node.js version."
    }
    $nodeVersion = [Version]$nodeVersionText
    if ($nodeVersion -lt [Version]"22.22.2") {
        throw "Node.js 22.22.2 or newer is required; found $nodeVersionText."
    }

    $pythonVersionText = (& python -c "import sys; print('.'.join(map(str, sys.version_info[:3])))").Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read Python version."
    }
    $pythonVersion = [Version]$pythonVersionText
    if ($pythonVersion.Major -ne 3 -or $pythonVersion.Minor -ne 11) {
        throw "Python 3.11 is required to match the fork Windows workflow; found $pythonVersionText."
    }

    $rustHost = (& rustc -vV | Select-String "^host:" | ForEach-Object { $_.Line.Split(":", 2)[1].Trim() })
    if ($LASTEXITCODE -ne 0 -or -not $rustHost) {
        throw "Unable to determine Rust host toolchain."
    }
    if ($rustHost -notmatch "windows-msvc") {
        throw "Rust MSVC Windows toolchain is required; found host '$rustHost'."
    }

    Invoke-Checked "Initialize git submodules" {
        git submodule update --init --recursive
    }

    $commit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $commit) {
        throw "Unable to resolve the current git commit."
    }
    $ref = (& git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to resolve the current git branch."
    }
    if (-not $ref) {
        $ref = "detached"
    }

    $dirty = [bool]((& git status --porcelain --untracked-files=no) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to inspect git status."
    }
    if ($dirty) {
        Write-Warning "Tracked files are modified. The build will be marked dirty and is not an exact commit artifact."
    }

    Write-Host "Building GSM commit $commit ($ref)"
    Write-Host "Node $nodeVersionText | Python $pythonVersionText | Rust $rustHost"

    Invoke-Checked "Install wheel builder" {
        python -m pip install --upgrade cibuildwheel
    }

    New-Item -ItemType Directory -Force -Path $wheelDir | Out-Null
    Get-ChildItem -LiteralPath $wheelDir -Filter "*.whl" -ErrorAction SilentlyContinue | Remove-Item -Force

    $previousCibwBuild = $env:CIBW_BUILD
    $previousCibwArchs = $env:CIBW_ARCHS_WINDOWS
    try {
        $env:CIBW_BUILD = "cp310-*"
        $env:CIBW_ARCHS_WINDOWS = "AMD64"
        Invoke-Checked "Build Windows backend wheel" {
            python -m cibuildwheel --output-dir electron-src/assets/python
        }
    }
    finally {
        $env:CIBW_BUILD = $previousCibwBuild
        $env:CIBW_ARCHS_WINDOWS = $previousCibwArchs
    }

    Invoke-Checked "Smoke test backend wheel" {
        node scripts/smoke-test-wheel.mjs
    }

    Invoke-Checked "Build overlay input server" {
        cargo build --release --manifest-path GSM_Overlay/input_server/Cargo.toml
    }
    $overlayServerDir = Join-Path $repoRoot "GSM_Overlay\input_server\bin\win32"
    New-Item -ItemType Directory -Force -Path $overlayServerDir | Out-Null
    Copy-Item (Join-Path $repoRoot "GSM_Overlay\input_server\target\release\gsm_overlay_server.exe") (Join-Path $overlayServerDir "gsm_overlay_server.exe") -Force

    # Match CI's LF normalization without leaving tracked files modified.
    Get-ChildItem -Path $overlayTemplateDir -Recurse -Filter "*.handlebars" | ForEach-Object {
        $path = $_.FullName
        $bytes = [System.IO.File]::ReadAllBytes($path)
        $originalTemplateBytes[$path] = $bytes
        $text = [System.Text.Encoding]::UTF8.GetString($bytes).Replace([Environment]::NewLine, [string][char]10)
        [System.IO.File]::WriteAllText($path, $text, [System.Text.UTF8Encoding]::new($false))
    }

    Push-Location (Join-Path $repoRoot "GSM_Overlay")
    try {
        Invoke-Checked "Install overlay dependencies" {
            npm ci --prefer-offline --no-audit --fund=false
        }
        Invoke-Checked "Build overlay" {
            npm run package
        }
    }
    finally {
        Pop-Location
        foreach ($entry in $originalTemplateBytes.GetEnumerator()) {
            [System.IO.File]::WriteAllBytes($entry.Key, [byte[]]$entry.Value)
        }
        $originalTemplateBytes.Clear()
    }

    Invoke-Checked "Install Electron dependencies" {
        npm ci --prefer-offline --no-audit --fund=false
    }

    if (-not $SkipTests) {
        Invoke-Checked "Test game provisioning transport" {
            npx vitest run electron-src/main/services/game_provisioning_command.test.ts --config vitest.config.ts
        }
    }

    Invoke-Checked "Build native package" {
        npm run build:native
    }
    Invoke-Checked "Compile Electron app" {
        npm run build
    }
    Invoke-Checked "Build Windows helpers" {
        npm run build:windows-helpers
    }
    Invoke-Checked "Stage overlay for Electron" {
        npm run stage:overlay
    }
    Invoke-Checked "Package Windows installer and unpacked app" {
        npx electron-builder --publish=never --win
    }
    Invoke-Checked "Verify packaged overlay" {
        npm run verify:overlay-package
    }

    $packageVersion = (Get-Content -Raw -Path (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
    if (-not $packageVersion) {
        throw "Unable to read package version."
    }

    $unpackedDir = Join-Path $distDir "win-unpacked"
    if (-not (Test-Path -LiteralPath $unpackedDir -PathType Container)) {
        throw "Expected unpacked Windows build is missing: $unpackedDir"
    }

    $zipPath = Join-Path $distDir "GameSentenceMiner-$packageVersion-win-unpacked.zip"
    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
    Compress-Archive -Path (Join-Path $unpackedDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

    $installer = Get-ChildItem -LiteralPath $distDir -Filter "GameSentenceMiner-Setup-*.exe" | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $installer) {
        throw "Expected GameSentenceMiner installer was not produced in $distDir."
    }

    $artifactDir = Join-Path $distDir "local-build-$commit"
    if (Test-Path -LiteralPath $artifactDir) {
        Remove-Item -LiteralPath $artifactDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null

    Copy-Item -LiteralPath $installer.FullName -Destination $artifactDir
    Copy-Item -LiteralPath $zipPath -Destination $artifactDir
    Get-ChildItem -LiteralPath $distDir -File | Where-Object { $_.Name -eq "latest.yml" -or $_.Extension -eq ".blockmap" } | Copy-Item -Destination $artifactDir

    $metadata = [ordered]@{
        repository = "kanjieater/GameSentenceMiner"
        commit = $commit
        ref = $ref
        packageVersion = $packageVersion
        builtAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        signed = $false
        builder = "local-windows"
        dirty = $dirty
    }
    $buildInfoPath = Join-Path $artifactDir "build-info.json"
    $metadata | ConvertTo-Json | Set-Content -LiteralPath $buildInfoPath -Encoding utf8

    Write-Host ""
    Write-Host "=== GSM local Windows build complete ===" -ForegroundColor Green
    Write-Host "Commit:    $commit"
    Write-Host "Installer: $(Join-Path $artifactDir $installer.Name)"
    Write-Host "Unpacked:  $(Join-Path $artifactDir (Split-Path $zipPath -Leaf))"
    Write-Host "Metadata:  $buildInfoPath"
}
finally {
    foreach ($entry in $originalTemplateBytes.GetEnumerator()) {
        [System.IO.File]::WriteAllBytes($entry.Key, [byte[]]$entry.Value)
    }
    Pop-Location
}
