[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][guid] $ApplicationId,
    [Parameter(Mandatory = $true)][guid] $ServicePrincipalObjectId,
    [string] $SenderMailbox = 'chx@ms-ext.biz',
    [string] $AdminUser = 'chx@ms-ext.biz',
    [string] $ScopeName = 'aoai-cost-test-sender',
    [switch] $TokenFromStdin
)

$ErrorActionPreference = 'Stop'
Import-Module ExchangeOnlineManagement

if ($SenderMailbox -notmatch '^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+$') {
    throw 'Sender mailbox contains invalid filter characters.'
}

if ($TokenFromStdin) {
    $token = [Console]::In.ReadLine()
    Connect-ExchangeOnline -AccessToken $token -UserPrincipalName $AdminUser -ShowBanner:$false
    $token = $null
}
else {
    Connect-ExchangeOnline -UserPrincipalName $AdminUser -ShowBanner:$false
}

try {
    $mailbox = Get-EXOMailbox -Identity $SenderMailbox
    $filter = "PrimarySmtpAddress -eq '$SenderMailbox'"
    $scope = Get-ManagementScope | Where-Object Name -eq $ScopeName
    if (-not $scope) {
        $scope = New-ManagementScope -Name $ScopeName -RecipientRestrictionFilter $filter
    }
    $recipients = @(Get-Recipient -RecipientPreviewFilter $scope.RecipientFilter)
    if ($recipients.Count -ne 1 -or
        $recipients[0].PrimarySmtpAddress.ToString() -ine $mailbox.PrimarySmtpAddress.ToString()) {
        throw 'The scope must contain exactly the specified sender mailbox.'
    }

    $principal = Get-ServicePrincipal | Where-Object AppId -eq $ApplicationId
    if (-not $principal) {
        New-ServicePrincipal -AppId $ApplicationId -ObjectId $ServicePrincipalObjectId `
            -DisplayName 'AOAI Cost Mail Dispatcher' | Out-Null
    }

    $assignmentName = "$ScopeName-mail-send"
    $assignment = Get-ManagementRoleAssignment | Where-Object Name -eq $assignmentName
    if (-not $assignment) {
        New-ManagementRoleAssignment -Name $assignmentName -Role 'Application Mail.Send' `
            -App $ServicePrincipalObjectId -CustomResourceScope $ScopeName | Out-Null
    }

    $verification = @(Test-ServicePrincipalAuthorization -Identity $ServicePrincipalObjectId -Resource $SenderMailbox)
    $mailSend = @($verification | Where-Object { $_.RoleName -eq 'Application Mail.Send' -and $_.InScope })
    if ($mailSend.Count -eq 0) {
        throw 'Scoped Application Mail.Send was not confirmed.'
    }
    [pscustomobject]@{
        ApplicationId = $ApplicationId
        SenderMailbox = $mailbox.PrimarySmtpAddress.ToString()
        ScopeName = $ScopeName
        ScopedMailSend = $true
        OrganizationWideGraphMailSendGranted = $false
        TransportRulesChanged = $false
    } | ConvertTo-Json -Compress
}
finally {
    Disconnect-ExchangeOnline -Confirm:$false
}
