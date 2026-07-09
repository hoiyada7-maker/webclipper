# Downloads the opendataloader-pdf CLI jar + a Temurin 21 JRE into
# src-tauri/resources/ so the PDF -> Markdown tab is self-contained (no
# system Java required). Idempotent: skips any part that already exists.
#
# Usage: pwsh scripts/fetch-runtime.ps1 [windows-x64|mac-aarch64|mac-x64|linux-x64]
param(
    [ValidateSet("windows-x64", "mac-aarch64", "mac-x64", "linux-x64")]
    [string]$Platform = "windows-x64"
)

$ErrorActionPreference = "Stop"

$CliVersion = "2.4.7"
$JreFeature = "21"

$RepoRoot = Resolve-Path "$PSScriptRoot/.."
$ResourcesDir = Join-Path $RepoRoot "src-tauri/resources"
$JarPath = Join-Path $ResourcesDir "opendataloader-pdf-cli.jar"
$JreDir = Join-Path $ResourcesDir "jre"

New-Item -ItemType Directory -Force -Path $ResourcesDir | Out-Null

switch ($Platform) {
    "windows-x64" { $AdoptiumOs = "windows"; $AdoptiumArch = "x64" }
    "mac-aarch64" { $AdoptiumOs = "mac"; $AdoptiumArch = "aarch64" }
    "mac-x64"     { $AdoptiumOs = "mac"; $AdoptiumArch = "x64" }
    "linux-x64"   { $AdoptiumOs = "linux"; $AdoptiumArch = "x64" }
}
$JavaBinName = if ($AdoptiumOs -eq "windows") { "java.exe" } else { "java" }
$JavaBinPath = Join-Path $JreDir "bin/$JavaBinName"

# ── CLI JAR ──────────────────────────────────────────────────────────────
if (Test-Path $JarPath) {
    Write-Host "[fetch-runtime] JAR already present, skipping: $JarPath"
} else {
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "opendataloader-cli-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    try {
        $zipUrl = "https://github.com/opendataloader-project/opendataloader-pdf/releases/download/v$CliVersion/opendataloader-pdf-cli-$CliVersion.zip"
        $zipPath = Join-Path $tmpDir "cli.zip"
        Write-Host "[fetch-runtime] downloading CLI jar: $zipUrl"
        # GitHub releases가 간헐적으로 504를 반환하므로 재시도
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -MaximumRetryCount 5 -RetryIntervalSec 10

        $extractDir = Join-Path $tmpDir "extracted"
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
        $jarFile = Get-ChildItem -Path $extractDir -Filter "opendataloader-pdf-cli-*.jar" -Recurse | Select-Object -First 1
        if (-not $jarFile) { throw "CLI jar not found inside downloaded zip" }
        Copy-Item -Path $jarFile.FullName -Destination $JarPath -Force
        Write-Host "[fetch-runtime] placed JAR: $JarPath"
    } finally {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    }
}

# ── JRE ──────────────────────────────────────────────────────────────────
if (Test-Path $JavaBinPath) {
    Write-Host "[fetch-runtime] JRE already present, skipping: $JavaBinPath"
} else {
    $isZip = $AdoptiumOs -eq "windows"
    $jreUrl = "https://api.adoptium.net/v3/binary/latest/$JreFeature/ga/$AdoptiumOs/$AdoptiumArch/jre/hotspot/normal/eclipse"

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "opendataloader-jre-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
    try {
        $archivePath = Join-Path $tmpDir $(if ($isZip) { "jre.zip" } else { "jre.tar.gz" })
        Write-Host "[fetch-runtime] downloading JRE ($Platform): $jreUrl"
        Invoke-WebRequest -Uri $jreUrl -OutFile $archivePath -MaximumRetryCount 5 -RetryIntervalSec 10

        $extractDir = Join-Path $tmpDir "extracted"
        New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
        if ($isZip) {
            Expand-Archive -Path $archivePath -DestinationPath $extractDir -Force
        } else {
            tar -xzf $archivePath -C $extractDir
        }

        # Find the dir that directly contains bin/java(.exe) — normalizes both
        # the plain "jdk-*-jre/" layout and macOS's "jdk-*-jre/Contents/Home/" layout.
        $javaFile = Get-ChildItem -Path $extractDir -Filter $JavaBinName -Recurse |
            Where-Object { $_.Directory.Name -eq "bin" } | Select-Object -First 1
        if (-not $javaFile) { throw "java binary not found inside downloaded JRE archive" }
        $jreSourceRoot = $javaFile.Directory.Parent.FullName

        if (Test-Path $JreDir) { Remove-Item -Recurse -Force $JreDir }
        Copy-Item -Path $jreSourceRoot -Destination $JreDir -Recurse -Force
        Write-Host "[fetch-runtime] placed JRE: $JreDir"
    } finally {
        Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
    }
}

Write-Host "[fetch-runtime] done."
