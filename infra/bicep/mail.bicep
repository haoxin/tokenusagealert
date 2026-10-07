targetScope = 'resourceGroup'

param location string
param namePrefix string
param tags object
param deployWebApp bool
param containerImage string
param storageAccountName string
param registryName string
param containerEnvironmentId string
param webIdentityPrincipalId string
param publicUrl string
param usageShardCount int = 1
param senderMailbox string = 'chx@ms-ext.biz'
param allowedRecipientDomains array = ['ms-ext.biz']
@description('Set true only after Exchange scoped Application Mail.Send has been verified.')
param authorizationReady bool = false

var contributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var reader = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
var acrPull = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var jobOperator = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b')
var jobName = '${namePrefix}-mail'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${namePrefix}-mail-id'
  location: location
  tags: tags
}
resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' existing = { name: storageAccountName }
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' existing = { parent: storage, name: 'default' }
resource configuration 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' existing = { parent: blobs, name: 'configuration' }
resource operations 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' existing = { parent: blobs, name: 'operations' }
resource prices 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' existing = { parent: blobs, name: 'pricing-current' }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }

resource configReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(configuration.id, identity.id, reader)
  scope: configuration
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: reader }
}
resource opsWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(operations.id, identity.id, contributor)
  scope: operations
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: contributor }
}
resource priceReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(prices.id, identity.id, reader)
  scope: prices
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: reader }
}
resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPull)
  scope: registry
  properties: { principalId: identity.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: acrPull }
}
resource job 'Microsoft.App/jobs@2025-01-01' = if (deployWebApp) {
  name: jobName
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identity.id}': {} } }
  properties: {
    environmentId: containerEnvironmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 420
      replicaRetryLimit: 1
      scheduleTriggerConfig: { cronExpression: '*/2 * * * *', parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registry.properties.loginServer, identity: identity.id }]
    }
    template: {
      containers: [{
        name: 'mail-dispatch'
        image: containerImage
        command: ['node']
        args: ['/prod/mail-dispatch/dist/index.js']
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'BLOB_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
          { name: 'MANAGED_IDENTITY_CLIENT_ID', value: identity.properties.clientId }
          { name: 'BLOB_AUTO_CREATE', value: 'false' }
          { name: 'MAIL_SENDER_MAILBOX', value: senderMailbox }
          { name: 'MAIL_ALLOWED_DOMAINS', value: join(allowedRecipientDomains, ',') }
          { name: 'MAIL_AUTHORIZATION_READY', value: authorizationReady ? 'true' : 'false' }
          { name: 'MAIL_PUBLIC_URL', value: publicUrl }
          { name: 'USAGE_SHARD_COUNT', value: string(usageShardCount) }
        ]
        resources: { cpu: json('0.5'), memory: '1Gi' }
      }]
    }
  }
  dependsOn: [configReader, opsWriter, priceReader, pull]
}
resource operator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployWebApp) {
  name: guid(resourceId('Microsoft.App/jobs', jobName), webIdentityPrincipalId, jobOperator)
  scope: job
  properties: { principalId: webIdentityPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: jobOperator }
}

output mailJobName string = deployWebApp ? jobName : ''
output mailIdentityClientId string = identity.properties.clientId
output mailIdentityPrincipalId string = identity.properties.principalId
