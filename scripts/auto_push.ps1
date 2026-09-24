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
# -LiteralPath: the folder name contains [ ], which plain Set-Location treats as a wildcard.
Set-Location -LiteralPath $repo -ErrorAction Stop
[Environment]::CurrentDirectory = $repo

# Every git call names the repo explicitly, so it works whatever folder the terminal started in.
function g { git -C $repo @args }

g rev-parse --git-dir *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not a git repository: $repo" -ForegroundColor Red
    exit 1
}

$lastSnapshot = ""
$stableSince = $null

Write-Host "Watching $repo - changes are pushed to origin/$Branch after $QuietSeconds s of no edits. Ctrl+C to stop."

while ($true) {
    $snapshot = (g status --porcelain) -join "`n"
    if ($snapshot) {
        # Include file timestamps so an edit to an already-modified file resets the timer.
        $stamps = g ls-files -m -o --exclude-standard | ForEach-Object {
            $full = Join-Path $repo $_
            if (Test-Path -LiteralPath $full) { (Get-Item -LiteralPath $full).LastWriteTimeUtc.Ticks }
        }
        $snapshot = $snapshot + ($stamps -join ",")
    }

    if (-not $snapshot) {
        $stableSince = $null
    } elseif ($snapshot -ne $lastSnapshot) {
        $stableSince = Get-Date
    } elseif ($stableSince -and ((Get-Date) - $stableSince).TotalSeconds -ge $QuietSeconds) {
        $files = (g status --porcelain | ForEach-Object { $_.Substring(3) }) -join ", "
        g add -A
        g commit -m "Auto-update: $files" | Out-Null
        g pull --rebase origin $Branch
        if ($LASTEXITCODE -eq 0) {
            g push origin $Branch
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
