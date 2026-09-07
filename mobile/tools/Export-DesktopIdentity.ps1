param(
    [Parameter(Mandatory = $true)]
    [string] $Password,
    [string] $UserId,
    [string] $VaultPath = "$env:APPDATA\ProtonnCord\secure-messaging\vault.bin",
    [string] $LocalStatePath = "$env:APPDATA\discord\Local State"
)

$ErrorActionPreference = 'Stop'
$iterations = 210000
$aad = [Text.Encoding]::UTF8.GetBytes('ProtonnCord/SecureMessaging/identity-backup/v2')
if ($Password.Length -lt 8 -or $Password.Length -gt 256) {
    throw 'Password must contain 8 to 256 characters.'
}

function ConvertTo-Base64Url([byte[]] $Bytes) {
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function ConvertFrom-Base64Url([string] $Value) {
    $padded = $Value.Replace('-', '+').Replace('_', '/')
    switch ($padded.Length % 4) {
        2 { $padded += '==' }
        3 { $padded += '=' }
    }
    return [Convert]::FromBase64String($padded)
}

$state = Get-Content -LiteralPath $LocalStatePath -Raw | ConvertFrom-Json
$wrappedKey = [Convert]::FromBase64String($state.os_crypt.encrypted_key)
if ([Text.Encoding]::ASCII.GetString($wrappedKey, 0, 5) -ne 'DPAPI') {
    throw 'Discord Local State uses an unsupported encryption-key format.'
}
$masterKey = [Security.Cryptography.ProtectedData]::Unprotect(
    $wrappedKey[5..($wrappedKey.Length - 1)],
    $null,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
)

$vaultBytes = [IO.File]::ReadAllBytes($VaultPath)
if ($vaultBytes.Length -lt 32 -or [Text.Encoding]::ASCII.GetString($vaultBytes, 0, 3) -ne 'v10') {
    throw 'The desktop Secure Messaging vault uses an unsupported format.'
}
$vaultPlaintext = New-Object byte[] ($vaultBytes.Length - 31)
$vaultCipher = [Security.Cryptography.AesGcm]::new($masterKey, 16)
try {
    $vaultCipher.Decrypt(
        $vaultBytes[3..14],
        $vaultBytes[15..($vaultBytes.Length - 17)],
        $vaultBytes[($vaultBytes.Length - 16)..($vaultBytes.Length - 1)],
        $vaultPlaintext,
        $null
    )
} finally {
    $vaultCipher.Dispose()
    [Array]::Clear($masterKey, 0, $masterKey.Length)
}

try {
    $vault = [Text.Encoding]::UTF8.GetString($vaultPlaintext) | ConvertFrom-Json
    if ($vault.version -ne 1 -or $null -eq $vault.accounts) {
        throw 'The desktop Secure Messaging vault is invalid or security-key locked.'
    }
    $accountIds = @($vault.accounts.psobject.Properties.Name)
    if (-not $UserId) {
        if ($accountIds.Count -ne 1) {
            throw 'Pass -UserId when the desktop vault contains more than one Discord account.'
        }
        $UserId = $accountIds[0]
    }
    if ($UserId -notmatch '^\d{17,20}$') {
        throw 'UserId must be a Discord snowflake.'
    }
    $accountProperty = $vault.accounts.psobject.Properties[$UserId]
    if ($null -eq $accountProperty) {
        throw "No desktop Secure Messaging identity exists for Discord user $UserId."
    }
    $desktopAccount = $accountProperty.Value
    $identity = $desktopAccount.identity
    $identityObject = [ordered]@{
        createdAt = [long] $identity.createdAt
        hpkePrivateKey = [string] $identity.hpkePrivateKey
        hpkePublicKey = [string] $identity.hpkePublicKey
        signingPrivateKey = [string] $identity.signingPrivateKey
        signingPublicKey = [string] $identity.signingPublicKey
    }
    $trusted = [ordered]@{}
    foreach ($peerProperty in @($desktopAccount.trustedPeers.psobject.Properties | Sort-Object Name)) {
        $peer = $peerProperty.Value
        if ($peer.keyChanged) {
            continue
        }
        $peerIdentity = $peer.identity
        $trusted[$peerProperty.Name] = [ordered]@{
            fingerprint = [string] $peerIdentity.fingerprint
            hpkePublicKey = [string] $peerIdentity.hpkePublicKey
            signingPublicKey = [string] $peerIdentity.signingPublicKey
            userId = [string] $peerIdentity.userId
        }
    }

    $conversations = [ordered]@{}
    foreach ($conversationProperty in @($desktopAccount.conversations.psobject.Properties | Sort-Object Name)) {
        $conversation = $conversationProperty.Value
        if (-not $conversation.enabled -or $null -ne $conversation.reviewRequired) {
            continue
        }
        $members = @($conversation.participantUserIds | Sort-Object -Unique)
        $recipients = @($conversation.selectedRecipients | Sort-Object userId)
        $valid = $members.Count -gt 0 -and $recipients.Count -gt 0
        foreach ($recipient in $recipients) {
            $trustedPeer = $trusted[[string] $recipient.userId]
            if ($null -eq $trustedPeer -or $trustedPeer.fingerprint -ne [string] $recipient.fingerprint) {
                $valid = $false
                break
            }
        }
        if ($valid) {
            $conversations[$conversationProperty.Name] = [ordered]@{
                members = $members
                recipients = @($recipients | ForEach-Object { [string] $_.userId })
            }
        }
    }

    $payload = [ordered]@{
        version = 2
        userId = $UserId
        identity = $identityObject
        trusted = $trusted
        conversations = $conversations
    } | ConvertTo-Json -Compress -Depth 8
    $payloadBytes = [Text.Encoding]::UTF8.GetBytes($payload)

    $salt = [byte[]]::new(16)
    $nonce = [byte[]]::new(12)
    [Security.Cryptography.RandomNumberGenerator]::Fill($salt)
    [Security.Cryptography.RandomNumberGenerator]::Fill($nonce)
    $deriver = [Security.Cryptography.Rfc2898DeriveBytes]::new(
        $Password,
        $salt,
        $iterations,
        [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    $backupKey = $deriver.GetBytes(32)
    $deriver.Dispose()
    $ciphertext = [byte[]]::new($payloadBytes.Length)
    $tag = [byte[]]::new(16)
    $backupCipher = [Security.Cryptography.AesGcm]::new($backupKey, 16)
    try {
        $backupCipher.Encrypt($nonce, $payloadBytes, $ciphertext, $tag, $aad)
    } finally {
        $backupCipher.Dispose()
        [Array]::Clear($backupKey, 0, $backupKey.Length)
        [Array]::Clear($payloadBytes, 0, $payloadBytes.Length)
    }
    $sealed = [byte[]]::new($ciphertext.Length + $tag.Length)
    [Array]::Copy($ciphertext, 0, $sealed, 0, $ciphertext.Length)
    [Array]::Copy($tag, 0, $sealed, $ciphertext.Length, $tag.Length)
    $token = 'PCIB2:{0}.{1}.{2}' -f (
        ConvertTo-Base64Url $salt
    ), (ConvertTo-Base64Url $nonce), (ConvertTo-Base64Url $sealed)
    Set-Clipboard -Value $token

    $fingerprintParts = @(
        [Text.Encoding]::UTF8.GetBytes("ProtonnCord/SecureMessaging/v1/fingerprint`0"),
        [Text.Encoding]::UTF8.GetBytes("$UserId`0"),
        (ConvertFrom-Base64Url $identity.signingPublicKey),
        (ConvertFrom-Base64Url $identity.hpkePublicKey)
    )
    $fingerprintInput = [byte[]]::new(($fingerprintParts | Measure-Object -Property Length -Sum).Sum)
    $fingerprintOffset = 0
    foreach ($part in $fingerprintParts) {
        [Array]::Copy($part, 0, $fingerprintInput, $fingerprintOffset, $part.Length)
        $fingerprintOffset += $part.Length
    }
    $digest = [Security.Cryptography.SHA256]::HashData($fingerprintInput)
    $formattedFingerprint = ([Convert]::ToHexString($digest) -split '(.{4})' | Where-Object Length) -join ' '
    Write-Output "Encrypted desktop state copied to the clipboard for $UserId."
    Write-Output "Transferred $($trusted.Count) trusted peer keys and $($conversations.Count) enabled conversations."
    Write-Output "Desktop fingerprint: $formattedFingerprint"
} finally {
    [Array]::Clear($vaultPlaintext, 0, $vaultPlaintext.Length)
}
