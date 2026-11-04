# open-cross-session installer for Windows - GitHub Release binary, no token.
#   irm https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.ps1 | iex
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = "leeguooooo/open-cross-session"
$InstallDir = if ($env:OCS_INSTALL_DIR) { $env:OCS_INSTALL_DIR } else { Join-Path $HOME ".local\bin" }
$Asset = "ocs-windows-x64"
# ARM64 Windows runs the x64 build under emulation.
if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "ARM64")) { throw "unsupported platform: $env:PROCESSOR_ARCHITECTURE" }

# Pin the release first, then fetch the archive and its .sha256 from that same tag. Two separate
# /releases/latest/download/ requests can land on different releases right after a publish.
# OCS_VERSION=0.9.12 (or v0.9.12) pins a version; `ocs upgrade` passes the one it checked.
if ($env:OCS_VERSION) {
  $Tag = "v" + $env:OCS_VERSION.TrimStart("v")
} else {
  $Request = [Net.HttpWebRequest]::Create("https://github.com/$Repo/releases/latest")
  $Request.Method = "HEAD"
  $Request.AllowAutoRedirect = $false
  $Request.UserAgent = "ocs-install"
  $Response = $Request.GetResponse()
  try { $Location = $Response.Headers["Location"] } finally { $Response.Close() }
  $Prefix = "https://github.com/$Repo/releases/tag/"
  $Tag = if ($Location -and $Location.StartsWith($Prefix)) { $Location.Substring($Prefix.Length) } else { "" }
}
if ($Tag -notmatch '^v\d+\.\d+\.\d+$') { throw "could not determine the ocs release to install (got '$Tag'); set OCS_VERSION=x.y.z to pin one" }

$Url = "https://github.com/$Repo/releases/download/$Tag/$Asset.zip"
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("ocs-install-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Tmp | Out-Null
try {
  Write-Host "downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile "$Tmp\$Asset.zip" -UseBasicParsing
  # Fail closed: the release always ships a .sha256; missing or mismatched means stop.
  Invoke-WebRequest -Uri "$Url.sha256" -OutFile "$Tmp\$Asset.zip.sha256" -UseBasicParsing
  $Expected = ((Get-Content "$Tmp\$Asset.zip.sha256" -Raw).Trim() -split "\s+")[0].ToLower()
  $Actual = (Get-FileHash "$Tmp\$Asset.zip" -Algorithm SHA256).Hash.ToLower()
  if (-not $Expected -or $Expected -ne $Actual) { throw "sha256 mismatch: expected $Expected got $Actual" }

  Expand-Archive -Path "$Tmp\$Asset.zip" -DestinationPath $Tmp -Force
  & "$Tmp\ocs.exe" help | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "downloaded binary failed smoke test" }
  $GotVersion = ((& "$Tmp\ocs.exe" version | Select-Object -First 1) -split "\s+")[1]
  if ("v$GotVersion" -ne $Tag) { throw "downloaded binary reports version $GotVersion, expected $($Tag.TrimStart('v'))" }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Target = Join-Path $InstallDir "ocs.exe"

  # A running LAN daemon locks ocs.exe: stop it first, restart on the new binary after.
  $RestartLan = $false
  if (Test-Path $Target) {
    # The old binary prints its "newer release available" notice on stderr. Under
    # $ErrorActionPreference = "Stop", Windows PowerShell 5.1 turns redirected native stderr
    # into a terminating error, which used to skip the restart exactly when an upgrade was due.
    $PrevPreference = $ErrorActionPreference
    $PrevNoCheck = $env:OCS_NO_UPDATE_CHECK
    try {
      $ErrorActionPreference = "Continue"
      $env:OCS_NO_UPDATE_CHECK = "1"
      $Raw = (& $Target lan status --json 2>$null) -join "`n"
      $Status = $null
      if ($Raw) { try { $Status = $Raw | ConvertFrom-Json } catch { } }
      if ($Status -and $Status.running) {
        & $Target lan down 2>$null | Out-Null
        $RestartLan = $true
      }
    } catch {
      Write-Warning "could not query the LAN daemon; if it was running, restart it with: ocs lan up"
    } finally {
      $ErrorActionPreference = $PrevPreference
      $env:OCS_NO_UPDATE_CHECK = $PrevNoCheck
    }
    # Windows can rename (not overwrite) an exe that is still mapped.
    Get-ChildItem -Path $InstallDir -Filter "ocs.exe.old-*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    Move-Item -Force $Target ("$Target.old-" + [DateTime]::Now.ToString("yyyyMMddHHmmss"))
  }
  Move-Item -Force "$Tmp\ocs.exe" $Target
  Write-Host "installed: $Target"

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not (($UserPath -split ";") -contains $InstallDir)) {
    [Environment]::SetEnvironmentVariable("Path", (($UserPath.TrimEnd(";") + ";" + $InstallDir).TrimStart(";")), "User")
    Write-Host "added $InstallDir to your user PATH (open a new terminal to pick it up)"
  }

  if ($env:OCS_INSTALL_SKILLS -ne "0") {
    & $Target skill install
    if ($LASTEXITCODE -ne 0) { Write-Warning "ocs installed, but skill setup failed; rerun: ocs skill install" }
  }
  if ($RestartLan) {
    & $Target lan up
    if ($LASTEXITCODE -ne 0) { Write-Warning "could not restart the LAN daemon; run: ocs lan up" }
  }
  Write-Host "ok: run 'ocs doctor' to get started"
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
