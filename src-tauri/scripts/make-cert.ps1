# Generate a local self-signed code-signing certificate and record its thumbprint
# into scripts/sign.env.json (which is gitignored).
#
# Run once per machine:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-cert.ps1
#
# What a self-signed cert gives you:
#   + a real Authenticode signature (signtool verify shows the signed status)
#   + the file hash is protected: tampering invalidates the signature
#   - Windows still says "unknown publisher" because the cert is not from a
#     trusted root CA. Removing the SmartScreen warning requires buying an
#     OV/EV code-signing certificate; when you have one, just put its
#     thumbprint into sign.env.json and every build will use it instead.

$ErrorActionPreference = 'Stop'

$thumb = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject 'CN=fsdymy1024, O=fy-desktop, C=CN' `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA `
  -KeyLength 3072 `
  -HashAlgorithm SHA256 `
  -FriendlyName 'fy-desktop code signing (self-signed)' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddYears(3) |
  Select-Object -ExpandProperty Thumbprint

Write-Host "[cert] thumbprint = $thumb"

$cfg = Join-Path $PSScriptRoot 'sign.env.json'
@{
  thumbprint = $thumb
  note       = 'local self-signed code signing cert; regenerate with scripts/make-cert.ps1 on another machine'
} | ConvertTo-Json | Set-Content -Path $cfg -Encoding ascii

Write-Host "[cert] written to $cfg"
Write-Host '[cert] done. Next build (npm run build) will sign the exe and the installer automatically.'
