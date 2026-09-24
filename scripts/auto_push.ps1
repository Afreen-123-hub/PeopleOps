# Auto-commit and push local changes so Render redeploys them.
# Usage (from the project folder):  powershell -ExecutionPolicy Bypass -File scripts\auto_push.ps1
# Stop with Ctrl+C.
#
# Waits until the files have stopped changing for $QuietSeconds before committing,
# so a burst of saves becomes one commit (and one Render deploy) instead of many.

param(
    [int]$QuietSeconds = 30,
    [string]$Branch = "main"
)

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$lastSnapshot = ""
$stableSince = $null

Write-Host "Watching $repo - changes are pushed to origin/$Branch after $QuietSeconds s of no edits. Ctrl+C to stop."

while ($true) {
    $snapshot = (git status --porcelain) -join "`n"
    if ($snapshot) {
        # Include file timestamps so an edit to an already-modified file resets the timer.
        $stamps = git ls-files -m -o --exclude-standard | ForEach-Object {
            if (Test-Path -LiteralPath $_) { (Get-Item -LiteralPath $_).LastWriteTimeUtc.Ticks }
        }
        $snapshot = $snapshot + ($stamps -join ",")
    }

    if (-not $snapshot) {
        $stableSince = $null
    } elseif ($snapshot -ne $lastSnapshot) {
        $stableSince = Get-Date
    } elseif ($stableSince -and ((Get-Date) - $stableSince).TotalSeconds -ge $QuietSeconds) {
        $files = (git status --porcelain | ForEach-Object { $_.Substring(3) }) -join ", "
        git add -A
        git commit -m "Auto-update: $files" | Out-Null
        git pull --rebase origin $Branch
        if ($LASTEXITCODE -eq 0) {
            git push origin $Branch
            if ($LASTEXITCODE -eq 0) {
                Write-Host "$(Get-Date -Format 'HH:mm:ss')  Pushed: $files"
            } else {
                Write-Host "$(Get-Date -Format 'HH:mm:ss')  Push failed - check the output above." -ForegroundColor Red
            }
        } else {
            Write-Host "$(Get-Date -Format 'HH:mm:ss')  Pull had conflicts - fix them, then the script will continue." -ForegroundColor Red
        }
        $stableSince = $null
    }

    $lastSnapshot = $snapshot
    Start-Sleep -Seconds 5
}
