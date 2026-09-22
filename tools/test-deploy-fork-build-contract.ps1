$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$expectedSha = "0123456789abcdef0123456789abcdef01234567"
$artifactName = "gsm-windows-$expectedSha"
$repo = "kanjieater/GameSentenceMiner"
$ref = "feature/test"
$destination = Join-Path $PSScriptRoot ".tmp-deploy-contract"

$script:workflowTriggered = $false
$script:runListCalls = 0

function global:gh {
    $global:LASTEXITCODE = 0
    $argv = @($args)
    $command = $argv -join " "

    if (
        $argv.Count -ge 3 -and
        $argv[0] -eq "api" -and
        $argv[1] -eq "repos/$repo/commits/feature%2Ftest"
    ) {
        Write-Output $expectedSha
        return
    }

    if ($argv.Count -ge 2 -and $argv[0] -eq "run" -and $argv[1] -eq "list") {
        $script:runListCalls += 1
        if ($script:runListCalls -eq 1) {
            @(
                [ordered]@{
                    databaseId = 100
                    headSha = $expectedSha
                    status = "completed"
                    conclusion = "success"
                    createdAt = "2026-09-20T00:00:00Z"
                    event = "workflow_dispatch"
                }
            ) | ConvertTo-Json -Compress | Write-Output
        } else {
            @(
                [ordered]@{
                    databaseId = 200
                    headSha = $expectedSha
                    status = "in_progress"
                    conclusion = $null
                    createdAt = "2026-09-22T00:00:00Z"
                    event = "workflow_dispatch"
                }
            ) | ConvertTo-Json -Compress | Write-Output
        }
        return
    }

    if (
        $argv.Count -ge 3 -and
        $argv[0] -eq "api" -and
        $argv[1] -eq "repos/$repo/actions/runs/100/artifacts"
    ) {
        [ordered]@{
            total_count = 0
            artifacts = @()
        } | ConvertTo-Json -Compress | Write-Output
        return
    }

    if (
        $argv.Count -ge 3 -and
        $argv[0] -eq "api" -and
        $argv[1] -eq "repos/$repo/actions/runs/200/artifacts"
    ) {
        [ordered]@{
            total_count = 1
            artifacts = @(
                [ordered]@{
                    id = 999
                    name = $artifactName
                    expired = $false
                }
            )
        } | ConvertTo-Json -Depth 4 -Compress | Write-Output
        return
    }

    if ($argv.Count -ge 2 -and $argv[0] -eq "workflow" -and $argv[1] -eq "run") {
        $script:workflowTriggered = $true
        return
    }

    if ($argv.Count -ge 3 -and $argv[0] -eq "run" -and $argv[1] -eq "watch") {
        return
    }

    if ($argv.Count -ge 3 -and $argv[0] -eq "run" -and $argv[1] -eq "view") {
        Write-Output "success"
        return
    }

    if ($argv.Count -ge 3 -and $argv[0] -eq "run" -and $argv[1] -eq "download") {
        $dirIndex = [Array]::IndexOf($argv, "--dir")
        if ($dirIndex -lt 0 -or $dirIndex + 1 -ge $argv.Count) {
            throw "Mock gh download did not receive --dir."
        }
        $targetDir = $argv[$dirIndex + 1]
        New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
        [ordered]@{
            repository = $repo
            commit = $expectedSha
            ref = $ref
            workflowRunId = "200"
            packageVersion = "0.0.0-test"
            builtAtUtc = "2026-09-22T00:00:00Z"
            signed = $false
        } | ConvertTo-Json | Set-Content -Path (Join-Path $targetDir "build-info.json") -Encoding utf8
        Set-Content -Path (Join-Path $targetDir "GameSentenceMiner-Setup-0.0.0-test.exe") -Value "fake"
        return
    }

    throw "Unexpected gh invocation: $command"
}

try {
    if (Test-Path $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }

    & (Join-Path $PSScriptRoot "deploy-fork-build.ps1") `
        -Repo $repo `
        -Ref $ref `
        -Destination $destination `
        -PollIntervalSeconds 0

    if (-not $script:workflowTriggered) {
        throw "Expected missing/expired historical artifact to trigger a replacement workflow run."
    }

    if ($script:runListCalls -lt 2) {
        throw "Expected helper to re-query workflow runs after triggering replacement build."
    }

    if (-not (Test-Path (Join-Path $destination "build-info.json"))) {
        throw "Expected replacement artifact to be downloaded."
    }

    Write-Host "deploy-fork-build contract test passed."
}
finally {
    Remove-Item Function:\gh -ErrorAction SilentlyContinue
    if (Test-Path $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
    }
}
