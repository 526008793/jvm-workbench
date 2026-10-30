param(
    [Parameter(Mandatory = $true)]
    [string]$Installer
)

$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path $Installer).Path
$installDirectory = Join-Path $env:RUNNER_TEMP 'TraceLogDock-installed'
$executable = Join-Path $installDirectory 'TraceLogDock.exe'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

# Run the real NSIS installer before testing the installed application.
$installation = Start-Process -FilePath $installerPath -ArgumentList @('/S', '/currentuser', "/D=$installDirectory") -Wait -PassThru
if ($installation.ExitCode -ne 0) {
    throw "Installer failed with exit code $($installation.ExitCode)"
}
if (-not (Test-Path $executable)) {
    throw 'Installation did not produce TraceLogDock.exe'
}

try {
    $fileVersion = (Get-Item $executable).VersionInfo.FileVersion
    if ($fileVersion -ne $version) {
        throw "Installed executable version $fileVersion does not match $version"
    }
    $reader = [System.IO.BinaryReader]::new([System.IO.File]::OpenRead($executable))
    try {
        $reader.BaseStream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        $reader.BaseStream.Position = $peOffset + 4
        if ($reader.ReadUInt16() -ne 0x8664) {
            throw 'Installed executable is not Windows x64'
        }
    } finally {
        $reader.Dispose()
    }

    # All smoke profiles, SSH endpoints and model services are isolated fixtures.
    $env:TRACELOGDOCK_SMOKE_EXECUTABLE = $executable
    foreach ($script in @('scripts/smoke-desktop.mjs', 'scripts/smoke-remote.mjs', 'scripts/smoke-multi-service-logs.mjs', 'scripts/smoke-arthas.mjs')) {
        & node $script
        if ($LASTEXITCODE -ne 0) {
            throw "$script failed with exit code $LASTEXITCODE"
        }
    }
} finally {
    Remove-Item Env:TRACELOGDOCK_SMOKE_EXECUTABLE -ErrorAction SilentlyContinue
    $uninstaller = Join-Path $installDirectory 'Uninstall TraceLogDock.exe'
    if (Test-Path $uninstaller) {
        $uninstallation = Start-Process -FilePath $uninstaller -ArgumentList @('/S', '/currentuser') -Wait -PassThru
        if ($uninstallation.ExitCode -ne 0) {
            throw "Uninstaller failed with exit code $($uninstallation.ExitCode)"
        }
        # NSIS may finish from a temporary copy after the original process has exited.
        $deadline = (Get-Date).AddSeconds(30)
        while ((Test-Path $executable) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
        }
        if (Test-Path $executable) {
            throw 'Uninstaller left the installed executable behind'
        }
    } else {
        throw 'Installation did not produce an uninstaller'
    }
}
Write-Output 'Windows installer, x64/version metadata, installed APP smoke flows and uninstall passed.'
