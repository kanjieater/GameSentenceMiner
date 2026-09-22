param(
    [string]$Ref = "",
    [string]$Repo = "kanjieater/GameSentenceMiner",
    [string]$Destination = "",
    [switch]$Install,
    [switch]$Silent
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$workflow = "fork_windows_build.yml"

function Invoke-GhJson {
    param([string[]]$Arguments)

    $output = & gh @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "gh command failed: gh $($Arguments -join ' ')"
    }
    return $output
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI (gh) is required. Install/authenticate gh, then retry."
}

if (-not $Ref) {
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $candidate = (& git branch --show-current 2>$null).Trim()
        if ($LASTEXITCODE -eq 0 -and $candidate) {
            $Ref = $candidate
        }
    }
    if (-not $Ref) {
        $Ref = "main"
    }
}

$encodedRef = [Uri]::EscapeDataString($Ref)
$expectedSha = (Invoke-GhJson @(
    "api",
    "repos/$Repo/commits/$encodedRef",
    "--jq",
    ".sha"
)).Trim()

if (-not $expectedSha) {
    throw "Could not resolve $Repo ref '$Ref' to a commit."
}

$shortSha = $expectedSha.Substring(0, 12)
if (-not $Destination) {
    $Destination = Join-Path (Get-Location) "artifacts/gsm-fork-$shortSha"
}

function Get-MatchingRun {
    $json = Invoke-GhJson @(
        "run", "list",
        "--repo", $Repo,
        "--workflow", $workflow,
        "--branch", $Ref,
        "--limit", "30",
        "--json", "databaseId,headSha,status,conclusion,createdAt,event"
    )

    $runs = @($json | ConvertFrom-Json)
    return $runs |
        Where-Object { $_.headSha -eq $expectedSha } |
        Sort-Object { [DateTime]$_.createdAt } -Descending |
        Select-Object -First 1
}

$run = Get-MatchingRun

if ($run -and $run.status -eq "completed" -and $run.conclusion -ne "success") {
    $run = $null
}

if (-not $run) {
    Write-Host "No usable Windows build exists for $Ref @ $shortSha. Triggering CI..."
    & gh workflow run $workflow --repo $Repo --ref $Ref
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to trigger workflow '$workflow' for ref '$Ref'."
    }

    for ($attempt = 0; $attempt -lt 45; $attempt += 1) {
        Start-Sleep -Seconds 2
        $candidate = Get-MatchingRun
        if (
            $candidate -and
            ($candidate.status -ne "completed" -or $candidate.conclusion -eq "success")
        ) {
            $run = $candidate
            break
        }
    }

    if (-not $run) {
        throw "Triggered the workflow but could not find its run for commit $expectedSha."
    }
}

if ($run.status -ne "completed") {
    Write-Host "Waiting for Windows build run $($run.databaseId)..."
    & gh run watch $run.databaseId --repo $Repo --exit-status
    if ($LASTEXITCODE -ne 0) {
        throw "Windows build run $($run.databaseId) failed."
    }
}

$conclusion = (Invoke-GhJson @(
    "run", "view",
    "$($run.databaseId)",
    "--repo", $Repo,
    "--json", "conclusion",
    "--jq", ".conclusion"
)).Trim()
if ($conclusion -ne "success") {
    throw "Windows build run $($run.databaseId) is not successful (conclusion: $conclusion)."
}

if (Test-Path $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$artifactName = "gsm-windows-$expectedSha"
Write-Host "Downloading $artifactName from run $($run.databaseId)..."
& gh run download $run.databaseId --repo $Repo --name $artifactName --dir $Destination
if ($LASTEXITCODE -ne 0) {
    throw "Failed to download artifact '$artifactName'."
}

$buildInfo = Get-ChildItem -Path $Destination -Recurse -Filter "build-info.json" |
    Select-Object -First 1
if (-not $buildInfo) {
    throw "Downloaded artifact is missing build-info.json."
}

$metadata = Get-Content -Raw -Path $buildInfo.FullName | ConvertFrom-Json
if ($metadata.commit -ne $expectedSha) {
    throw "Artifact commit '$($metadata.commit)' does not match requested commit '$expectedSha'."
}

$installer = Get-ChildItem -Path $Destination -Recurse -Filter "GameSentenceMiner-Setup-*.exe" |
    Select-Object -First 1
if (-not $installer) {
    throw "Downloaded artifact is missing the GameSentenceMiner installer."
}

Write-Host "Verified fork build $shortSha."
Write-Host "Installer: $($installer.FullName)"

if ($Install) {
    $arguments = @()
    if ($Silent) {
        $arguments += "/S"
    }

    Write-Host "Installing GameSentenceMiner fork build $shortSha..."
    $process = Start-Process -FilePath $installer.FullName -ArgumentList $arguments -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "Installer exited with code $($process.ExitCode)."
    }
    Write-Host "Installation completed."
}
