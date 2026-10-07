targetScope = 'subscription'

@description('Resource group for the test deployment.')
param resourceGroupName string = 'aoai-cost-alert-test-rg'

@description('Azure region for the resource group and deployed resources.')
param location string = 'swedencentral'

@description('Lowercase prefix used by Azure resources.')
param namePrefix string = 'aoai-cost-test'

@description('Whether to create or update the Web Container App and sync Jobs.')
param deployWebApp bool = false

@description('Immutable image shared by Web and sync Jobs. Required only when deployWebApp is true.')
param containerImage string = ''

@allowed(['private', 'public'])
param storageAccessMode string = 'private'

@minValue(1)
@maxValue(16)
param usageShardCount int = 1

@minValue(1)
@maxValue(64)
param usageTenantConcurrency int = 8

@minValue(1)
@maxValue(64)
param usageSubscriptionConcurrency int = 8

@minValue(16)
@maxValue(256)
param usageRequestConcurrency int = 32

param mailAuthorizationReady bool = false
param mailSenderMailbox string = 'chx@ms-ext.biz'
@minLength(1)
param mailAllowedRecipientDomains array = ['ms-ext.biz']

@description('Current storage lifecycle policy rules, including cloud-only rules. Required explicitly; pass [] only after confirming no policy exists.')
param existingStorageLifecycleRules array

param tags object = {
  application: 'tokenusagealert'
  environment: 'test'
  owner: 'chx@ms-ext.biz'
  dataClassification: 'internal'
}

resource testResourceGroup 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module firstBatch './main.bicep' = {
  name: 'first-batch'
  scope: testResourceGroup
  params: {
    location: location
    namePrefix: namePrefix
    deployWebApp: deployWebApp
    containerImage: containerImage
    storageAccessMode: storageAccessMode
    usageShardCount: usageShardCount
    usageTenantConcurrency: usageTenantConcurrency
    usageSubscriptionConcurrency: usageSubscriptionConcurrency
    usageRequestConcurrency: usageRequestConcurrency
    mailAuthorizationReady: mailAuthorizationReady
    mailSenderMailbox: mailSenderMailbox
    mailAllowedRecipientDomains: mailAllowedRecipientDomains
    existingStorageLifecycleRules: existingStorageLifecycleRules
    tags: tags
  }
}

output resourceGroupName string = testResourceGroup.name
output containerAppName string = firstBatch.outputs.containerAppName
output containerAppFqdn string = firstBatch.outputs.containerAppFqdn
output storageAccountName string = firstBatch.outputs.storageAccountName
output registryName string = firstBatch.outputs.registryName
output webIdentityClientId string = firstBatch.outputs.webIdentityClientId
output webIdentityPrincipalId string = firstBatch.outputs.webIdentityPrincipalId
output collectorIdentityClientId string = firstBatch.outputs.collectorIdentityClientId
output collectorIdentityPrincipalId string = firstBatch.outputs.collectorIdentityPrincipalId
output offboardingIdentityClientId string = firstBatch.outputs.offboardingIdentityClientId
output offboardingIdentityPrincipalId string = firstBatch.outputs.offboardingIdentityPrincipalId
output authorizationSyncJobName string = firstBatch.outputs.authorizationSyncJobName
output pricingJobName string = firstBatch.outputs.pricingJobName
output pricingIdentityClientId string = firstBatch.outputs.pricingIdentityClientId
output pricingIdentityPrincipalId string = firstBatch.outputs.pricingIdentityPrincipalId
output usageJobName string = firstBatch.outputs.usageJobName
output mailJobName string = firstBatch.outputs.mailJobName
output mailIdentityClientId string = firstBatch.outputs.mailIdentityClientId
output mailIdentityPrincipalId string = firstBatch.outputs.mailIdentityPrincipalId
output virtualNetworkName string = firstBatch.outputs.virtualNetworkName
output blobPrivateEndpointName string = firstBatch.outputs.blobPrivateEndpointName
output storageAccessMode string = firstBatch.outputs.storageAccessMode
output containerEnvironmentName string = firstBatch.outputs.containerEnvironmentName
