<#
.SYNOPSIS
  Triggers a production deploy of ANC ERP on the VPS, from your Windows
  machine, over SSH.

.DESCRIPTION
  This script does NOT deploy anything itself. Production is a Linux
  VPS (Ubuntu, PM2, Nginx) - see docs/PRODUCTION_DEPLOYMENT.md. All of
  the real deploy logic, including the mandatory migration safety
  gate, already lives on the server in scripts/deploy.sh. Re-writing
  that logic here in PowerShell would create a second copy that can
  drift out of sync with the real one - this script only opens an
  interactive SSH session and runs the server's own script, so there
  is exactly one place that decides what a safe deploy looks like.

  IMPORTANT - read before running:
    docs/PRODUCTION_DEPLOYMENT.md section 3 documents that this
    repo's committed migration history is known to be INCOMPLETE
    relative to schema.prisma for several older tables. scripts/deploy.sh
    therefore only ever SHOWS `prisma migrate status` and then stops
    for a y/N confirmation before building/restarting - it never runs
    `prisma migrate deploy` for you, and neither does this script.
    When the SSH session reaches that prompt, read its output
    carefully before answering.

  Steps this script runs, in order, all on the VPS via SSH:
    1. cd to the app directory
    2. git fetch + show what `git pull` would bring in (log preview only)
    3. git pull origin main
    4. bash scripts/deploy.sh   (interactive - you will be prompted there)

.PARAMETER VpsHost
  SSH host - hostname or IP of the VPS (e.g. erp.alnaeemcargo.com or its IP).

.PARAMETER VpsUser
  SSH username on the VPS (the account that owns the app directory and
  can run pm2/npm there).

.PARAMETER AppPath
  Absolute path to the app's working directory on the VPS
  (e.g. /home/deploy/al-naeem-erp).

.PARAMETER SshKeyPath
  Optional path to a private key file, if you don't already have an
  SSH agent / default key set up for this host.

.EXAMPLE
  .\scripts\deploy-from-windows.ps1 -VpsHost erp.alnaeemcargo.com -VpsUser deploy -AppPath /home/deploy/al-naeem-erp

.EXAMPLE
  .\scripts\deploy-from-windows.ps1 -VpsHost 203.0.113.10 -VpsUser deploy -AppPath /home/deploy/al-naeem-erp -SshKeyPath C:\Users\abdul\.ssh\anc_erp_vps

.NOTES
  Requires the Windows OpenSSH Client (built into Windows 10/11 -
  Settings > Optional Features > "OpenSSH Client", or
  `Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0`).
  Never commit real VpsHost/VpsUser/AppPath values into this repo if
  they are sensitive - pass them as parameters (or your own untracked
  local wrapper / saved PowerShell parameter set) instead.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VpsHost,

    [Parameter(Mandatory = $true)]
    [string]$VpsUser,

    [Parameter(Mandatory = $true)]
    [string]$AppPath,

    [string]$SshKeyPath,

    # Branch to deploy. Defaults to main, matching this session's own
    # merge-to-main workflow. Change only if you deliberately want to
    # deploy a different branch.
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

function Invoke-RemoteSsh {
    param(
        [string]$Command,
        [switch]$Interactive
    )

    $sshArgs = @()
    if ($SshKeyPath) { $sshArgs += @("-i", $SshKeyPath) }
    if ($Interactive) { $sshArgs += "-t" }
    $sshArgs += "$VpsUser@$VpsHost"
    $sshArgs += $Command

    Write-Host ">>> ssh $($sshArgs -join ' ')" -ForegroundColor DarkGray
    & ssh @sshArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Remote command failed (exit code $LASTEXITCODE): $Command"
    }
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    throw "ssh.exe not found. Install the Windows OpenSSH Client (Settings > Optional Features), then retry."
}

$remoteAppCd = "cd '$AppPath'"

Write-Host "`n=== ANC ERP deploy ($VpsUser@$VpsHost : $AppPath, branch $Branch) ===" -ForegroundColor Cyan

Write-Host "`n--- 1. Fetching and previewing incoming changes (read-only) ---" -ForegroundColor Cyan
Invoke-RemoteSsh -Command "$remoteAppCd && git fetch origin && git log --oneline HEAD..origin/$Branch"

$proceed = Read-Host "`nAbove is what 'git pull' will bring in on the VPS. Continue? [y/N]"
if ($proceed -ne "y" -and $proceed -ne "Y") {
    Write-Host "Aborted - nothing changed on the VPS." -ForegroundColor Yellow
    exit 1
}

Write-Host "`n--- 2. git pull origin $Branch ---" -ForegroundColor Cyan
Invoke-RemoteSsh -Command "$remoteAppCd && git pull origin $Branch"

Write-Host "`n--- 3. Running the server's own scripts/deploy.sh (interactive - watch for its migration-status prompt) ---" -ForegroundColor Cyan
Invoke-RemoteSsh -Interactive -Command "$remoteAppCd && bash scripts/deploy.sh"

Write-Host "`n=== Done. Verify with: ssh $VpsUser@$VpsHost 'pm2 status && pm2 logs anc-erp --lines 50' ===" -ForegroundColor Green
