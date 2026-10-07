[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $ResourceGroup,

    [Parameter(Mandatory = $true)]
    [string] $ContainerAppName,

    [Parameter(Mandatory = $true)]
    [string] $TenantId,

    [Parameter(Mandatory = $true)]
    [string] $ClientId,

    [Parameter(Mandatory = $true)]
    [securestring] $ClientSecret
)

$ErrorActionPreference = 'Stop'

$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ClientSecret)
try {
    $plainClientSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)

    az containerapp auth microsoft update `
        --resource-group $ResourceGroup `
        --name $ContainerAppName `
        --client-id $ClientId `
        --client-secret $plainClientSecret `
        --tenant-id $TenantId `
        --issuer "https://login.microsoftonline.com/$TenantId/v2.0" `
        --yes
    if ($LASTEXITCODE -ne 0) {
        throw 'Microsoft Entra provider configuration failed. Easy Auth is not confirmed.'
    }

    az containerapp auth update `
        --resource-group $ResourceGroup `
        --name $ContainerAppName `
        --enabled true `
        --unauthenticated-client-action RedirectToLoginPage `
        --redirect-provider azureactivedirectory
    if ($LASTEXITCODE -ne 0) {
        throw 'Easy Auth access enforcement failed. Do not onboard tenants before verifying login protection.'
    }
}
finally {
    if ($secretPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    }
    $plainClientSecret = $null
}

Write-Host 'Easy Auth configured. Set "Assignment required?" on the Enterprise Application and assign the approved operations group.'
