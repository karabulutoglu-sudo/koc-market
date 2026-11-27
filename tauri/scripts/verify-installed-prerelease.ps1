$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REF -cne 'refs/heads/codex/yayin1-onsurum-kabul' -or
    $env:GITHUB_REPOSITORY -cne 'karabulutoglu-sudo/koc-market') {
    throw 'Bu kurulum provası yalnızca kabul dalındaki geçici GitHub Windows VM üzerinde çalışır.'
}

$repo = $env:GITHUB_REPOSITORY
$candidateSha = 'd174499268b5abbf281356239e4a8277f0e3dfee'
$candidateInstallerSha256 = 'e734243483fe942bf1d7248894a779fc6afd464fcf8cfe4905817b23ef338a46'
$profileDir = Join-Path $env:APPDATA 'com.kocmarket.app'
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Koç Market'
$helper = Join-Path $PSScriptRoot 'verify-installed-prerelease.mjs'
$staging = Join-Path $env:RUNNER_TEMP ('koc-prerelease-' + [guid]::NewGuid())
$null = New-Item -Path $staging -ItemType Directory

function Read-GitHubJson($path) {
    $result = gh api $path
    if ($LASTEXITCODE -ne 0) { throw "GitHub sorgusu başarısız oldu ($path)." }
    $result | ConvertFrom-Json
}

function Assert-LiveVersion {
    $manifest = Invoke-RestMethod -Uri "https://github.com/$repo/releases/latest/download/latest.json" -TimeoutSec 30
    if ($manifest.version -cne '2.0.4') { throw "Mağaza güncelleme sürümü 2.0.4 olmalı ($($manifest.version))." }
    Write-Host 'MAĞAZA GÜNCELLEME ADRESİ 2.0.4'
}

function Receive-Installer($version, $prerelease) {
    $tag = "tauri-v$version"
    $name = "Koc.Market_${version}_x64-setup.exe"
    $release = Read-GitHubJson "repos/$repo/releases/tags/$tag"
    if ($release.draft -or $release.prerelease -ne $prerelease -or $release.tag_name -cne $tag) {
        throw "Sürüm bilgisi beklenen dağıtım türüyle eşleşmiyor ($tag)."
    }
    if ($prerelease) {
        $commit = Read-GitHubJson "repos/$repo/commits/$tag"
        if ($commit.sha -cne $candidateSha) { throw "Ön sürüm farklı bir commit'e bağlı ($($commit.sha))." }
    }
    $asset = @($release.assets | Where-Object name -CEQ $name)
    if ($asset.Count -ne 1) { throw "Beklenen NSIS dosyası bulunamadı ($name)." }
    gh release download $tag --repo $repo --pattern $name --dir $staging | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Kurulum dosyası indirilemedi ($name)." }
    $path = Join-Path $staging $name
    $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ((Get-Item -LiteralPath $path).Length -ne $asset[0].size -or
        ($asset[0].digest -and $asset[0].digest -cne "sha256:$actual")) {
        throw "Kurulum dosyası GitHub varlık bilgileriyle uyuşmuyor ($name)."
    }
    if ($prerelease -and $actual -cne $candidateInstallerSha256) {
        throw 'Ön sürüm dosyası imza denetimine alınan paketle uyuşmuyor.'
    }
    Write-Host "PAKET $tag SHA256 $actual"
    $path
}

function Install-And-ReadBinary($installer, $version) {
    $process = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -PassThru
    try {
        if (-not $process.WaitForExit(180000)) { throw "NSIS kurulumu zamanında tamamlanmadı ($version)." }
        if ($process.ExitCode -ne 0) { throw "NSIS kurulum çıkış kodu $($process.ExitCode) ($version)." }
    } finally {
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
    $record = Get-ItemProperty -LiteralPath $registryPath
    $installDirectory = $record.InstallLocation.Trim('"')
    $binary = Join-Path $installDirectory 'koc-market.exe'
    $uninstaller = Join-Path $installDirectory 'uninstall.exe'
    if ($record.DisplayVersion -cne $version -or -not (Test-Path -LiteralPath $binary -PathType Leaf) -or
        -not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
        throw "Kurulum sürümü veya dosyaları uyuşmuyor ($version)."
    }
    $installed = Get-Item -LiteralPath $binary
    if ($installed.VersionInfo.ProductVersion -notmatch "^$([regex]::Escape($version))(?:\.0)?$") {
        throw "Kurulu ikili sürümü $($installed.VersionInfo.ProductVersion), beklenen $version."
    }
    Write-Host "KURULUM $version HKCU ve dosya sürümü doğrulandı."
    $installed.FullName
}

function Invoke-Proof($command, $version, $port = 0) {
    node $helper $command $profileDir $version $port
    if ($LASTEXITCODE -ne 0) { throw "Sentetik profil provası başarısız oldu ($command, $version)." }
}

function Run-InstalledBinary($binary, $version, $port) {
    $saved = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$port"
    $app = Start-Process -FilePath $binary -PassThru
    try {
        Invoke-Proof 'webview' $version $port
        $app.Refresh()
        if ($app.HasExited -or -not $app.CloseMainWindow() -or -not $app.WaitForExit(45000) -or $app.ExitCode -ne 0) {
            throw "Kurulu uygulama normal kapanmadı ($version)."
        }
    } finally {
        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $saved
        if (-not $app.HasExited) { $app.Kill() }
        $app.Dispose()
    }
    Invoke-Proof 'disk' $version
}

if ((Test-Path -LiteralPath $profileDir) -or (Test-Path -LiteralPath $registryPath) -or
    $env:KOC_DATA_DIR -or $env:KOC_TEST_JS) {
    throw 'Prova VM üzerinde boş bir uygulama profili gerektirir.'
}
Assert-LiveVersion
$stable = Receive-Installer '2.0.4' $false
$candidate = Receive-Installer '2.1.0' $true
$stableBinary = Install-And-ReadBinary $stable '2.0.4'
$stableHash = (Get-FileHash -LiteralPath $stableBinary -Algorithm SHA256).Hash
Invoke-Proof 'seed' '2.0.4'
Run-InstalledBinary $stableBinary '2.0.4' 43428
$candidateBinary = Install-And-ReadBinary $candidate '2.1.0'
if ($stableBinary -cne $candidateBinary -or
    (Get-FileHash -LiteralPath $candidateBinary -Algorithm SHA256).Hash -ceq $stableHash) {
    throw 'Ön sürüm aynı kurulumda eski ikiliyi değiştirmedi.'
}
Run-InstalledBinary $candidateBinary '2.1.0' 43429
Assert-LiveVersion
Write-Host '2.0.4 → 2.1.0 KURULUM, YÜKSELTME VE DİSK PROVASI GEÇTİ.'
