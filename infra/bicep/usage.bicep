targetScope = 'resourceGroup'

param location string
param namePrefix string
param tags object
param deployWebApp bool
param containerImage string
param storageAccountName string
param registryName string
param containerEnvironmentId string
param collectorIdentityName string
param webIdentityPrincipalId string
param senderMailbox string = 'chx@ms-ext.biz'
param allowedRecipientDomains array = ['ms-ext.biz']

@minValue(1)
@maxValue(16)
param shardCount int = 1

@minValue(1)
@maxValue(64)
param tenantConcurrency int = 8

@minValue(1)
@maxValue(64)
param subscriptionConcurrency int = 8

@minValue(16)
@maxValue(256)
@description('Combined HTTP request concurrency budget across all usage shards.')
param totalRequestConcurrency int = 32

var jobName = '${namePrefix}-usage'
var contributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var reader = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1')
var jobsOperator = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b')

resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' existing = { name: storageAccountName }
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' existing = { parent: storage, name: 'default' }
resource collector 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = { name: collectorIdentityName }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource prices 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' existing = {
  parent: blobs
  name: 'pricing-current'
}
resource usage 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobs
  name: 'usage'
  properties: { publicAccess: 'None' }
}
resource collectorUsageWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(usage.id, collector.id, contributor)
  scope: usage
  properties: { principalId: collector.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: contributor }
}
resource collectorPriceReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(prices.id, collector.id, reader)
  scope: prices
  properties: { principalId: collector.properties.principalId, principalType: 'ServicePrincipal', roleDefinitionId: reader }
}
resource webUsageReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(usage.id, webIdentityPrincipalId, reader)
  scope: usage
  properties: { principalId: webIdentityPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: reader }
}

resource collectorJobs 'Microsoft.App/jobs@2025-01-01' = [for shardId in range(0, shardCount): if (deployWebApp) {
  name: shardId == 0 ? jobName : '${jobName}-${shardId}'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${collector.id}': {} }
  }
  properties: {
    environmentId: containerEnvironmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1500
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '15 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [{ server: registry.properties.loginServer, identity: collector.id }]
    }
    template: {
      containers: [
        {
          name: 'usage-collector'
          image: containerImage
          command: ['node']
          args: ['/prod/usage-collector/dist/index.js']
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'USAGE_SOURCE', value: 'azure-monitor' }
            { name: 'BLOB_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
            { name: 'MANAGED_IDENTITY_CLIENT_ID', value: collector.properties.clientId }
            { name: 'BLOB_AUTO_CREATE', value: 'false' }
            { name: 'MAIL_SENDER_MAILBOX', value: senderMailbox }
            { name: 'MAIL_ALLOWED_DOMAINS', value: join(allowedRecipientDomains, ',') }
            { name: 'USAGE_SHARD_ID', value: string(shardId) }
            { name: 'USAGE_SHARD_COUNT', value: string(shardCount) }
            { name: 'USAGE_TENANT_CONCURRENCY', value: string(tenantConcurrency) }
            { name: 'USAGE_SUBSCRIPTION_CONCURRENCY', value: string(subscriptionConcurrency) }
            { name: 'USAGE_ACCOUNT_CONCURRENCY', value: '2' }
            { name: 'USAGE_REQUEST_CONCURRENCY', value: string(totalRequestConcurrency) }
            { name: 'USAGE_TIMEOUT_SECONDS', value: '1200' }
          ]
          resources: { cpu: json('1.0'), memory: '2Gi' }
        }
      ]
    }
  }
  dependsOn: [collectorUsageWriter, collectorPriceReader]
}]
resource webJobOperators 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for shardId in range(0, shardCount): if (deployWebApp) {
  scope: collectorJobs[shardId]
  name: guid(resourceId('Microsoft.App/jobs', shardId == 0 ? jobName : '${jobName}-${shardId}'), webIdentityPrincipalId, jobsOperator)
  properties: { principalId: webIdentityPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: jobsOperator }
}]

output usageJobName string = deployWebApp ? collectorJobs[0]!.name : ''
