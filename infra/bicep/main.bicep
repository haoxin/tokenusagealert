targetScope = 'resourceGroup'

@description('Azure region for the deployed resources.')
param location string = resourceGroup().location

@minLength(3)
@maxLength(18)
@description('Lowercase application prefix used in resource names.')
param namePrefix string

@description('Whether to create or update the Web Container App and sync Jobs. Keep false during bootstrap before the ACR image exists.')
param deployWebApp bool = false

@description('Immutable container image including registry host and SHA-256 digest, shared by Web and sync Jobs. Required when deployWebApp is true.')
param containerImage string = ''

@description('Current storage lifecycle policy rules, including cloud-only rules. Required explicitly; pass [] only after confirming no policy exists.')
param existingStorageLifecycleRules array

@allowed(['private', 'public'])
@description('Blob network access for a new installation. Private preserves VNet/Private Endpoint; public uses Consumption without a customer VNet, while retaining identity-only private containers. Do not change this on an existing installation.')
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

@description('Requires verified Exchange Application RBAC. Keep false while organization customization/authorization is pending.')
param mailAuthorizationReady bool = false

@description('Initial sender mailbox in this partner tenant. Saved application settings take precedence.')
param mailSenderMailbox string = 'chx@ms-ext.biz'

@minLength(1)
@description('Allowed notification recipient domains, shared by Web, Collector and Mail Dispatcher.')
param mailAllowedRecipientDomains array = ['ms-ext.biz']

@description('Address space for the private-mode VNet.')
param vnetAddressPrefix string = '10.40.0.0/16'

@description('Dedicated subnet for the Container Apps managed environment. A /23 supports the consumption environment.')
param containerAppsSubnetPrefix string = '10.40.0.0/23'

@description('Dedicated subnet for private endpoints.')
param privateEndpointSubnetPrefix string = '10.40.2.0/24'

@description('Tags applied to all resources.')
param tags object = {
  application: 'tokenusagealert'
  environment: 'prod'
  dataClassification: 'internal'
}

var uniqueSuffix = uniqueString(subscription().subscriptionId, resourceGroup().id)
var usePrivateStorage = storageAccessMode == 'private'
var compactPrefix = toLower(replace(namePrefix, '-', ''))
var storageName = take('${compactPrefix}${uniqueSuffix}', 24)
var acrName = take('${compactPrefix}${uniqueSuffix}', 50)
var webIdentityName = '${namePrefix}-web-id'
var collectorIdentityName = '${namePrefix}-collector-id'
var offboardingIdentityName = '${namePrefix}-offboarding-id'
var workspaceName = '${namePrefix}-logs'
var appInsightsName = '${namePrefix}-appi'
var vnetName = '${namePrefix}-vnet'
var environmentName = usePrivateStorage ? '${namePrefix}-cae-private' : '${namePrefix}-cae-public'
var webAppName = '${namePrefix}-web'
var authorizationSyncJobName = '${namePrefix}-auth-sync'
var blobPrivateEndpointName = '${namePrefix}-blob-pe'
var blobPrivateDnsZoneName = 'privatelink.blob.${environment().suffixes.storage}'
var blobDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)
var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var jobsOperatorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b'
)

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: webIdentityName
  location: location
  tags: tags
}

resource collectorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: collectorIdentityName
  location: location
  tags: tags
}

resource offboardingIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: offboardingIdentityName
  location: location
  tags: tags
}

resource offboardingIdentityLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: 'protect-offboarding-identity'
  scope: offboardingIdentity
  properties: {
    level: 'CanNotDelete'
    notes: 'Customer Lighthouse authorizations refer to this stable identity object ID.'
  }
}

resource virtualNetwork 'Microsoft.Network/virtualNetworks@2024-07-01' = if (usePrivateStorage) {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
  }
}

resource containerAppsSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-07-01' = if (usePrivateStorage) {
  parent: virtualNetwork
  name: 'aca-infrastructure'
  properties: {
    addressPrefix: containerAppsSubnetPrefix
    delegations: [
      {
        name: 'aca-environment-delegation'
        properties: {
          serviceName: 'Microsoft.App/environments'
        }
      }
    ]
  }
}

resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-07-01' = if (usePrivateStorage) {
  parent: virtualNetwork
  name: 'private-endpoints'
  properties: {
    addressPrefix: privateEndpointSubnetPrefix
    privateEndpointNetworkPolicies: 'Disabled'
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: storageName
  location: location
  tags: tags
  sku: {
    name: 'Standard_ZRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    networkAcls: {
      bypass: 'None'
      defaultAction: usePrivateStorage ? 'Deny' : 'Allow'
      ipRules: []
      virtualNetworkRules: []
    }
    publicNetworkAccess: usePrivateStorage ? 'Disabled' : 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    isVersioningEnabled: true
  }
}

resource configurationContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobService
  name: 'configuration'
  properties: {
    publicAccess: 'None'
  }
}

resource auditContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobService
  name: 'audit'
  properties: {
    publicAccess: 'None'
  }
}

resource inventoryContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobService
  name: 'inventory'
  properties: {
    publicAccess: 'None'
  }
}

resource operationsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = {
  parent: blobService
  name: 'operations'
  properties: {
    publicAccess: 'None'
  }
}

resource blobPrivateDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = if (usePrivateStorage) {
  name: blobPrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource blobPrivateDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (usePrivateStorage) {
  parent: blobPrivateDnsZone
  name: '${namePrefix}-blob-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: virtualNetwork!.id
    }
  }
}

resource blobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2024-07-01' = if (usePrivateStorage) {
  name: blobPrivateEndpointName
  location: location
  tags: tags
  properties: {
    customNetworkInterfaceName: '${blobPrivateEndpointName}-nic'
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: {
          groupIds: [
            'blob'
          ]
          privateLinkServiceId: storage.id
          requestMessage: 'AOAI Cost platform Blob access'
        }
      }
    ]
    subnet: {
      id: privateEndpointSubnet!.id
    }
  }
}

resource blobPrivateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-07-01' = if (usePrivateStorage) {
  parent: blobPrivateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: blobPrivateDnsZone!.id
        }
      }
    ]
  }
}

resource configurationWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: configurationContainer
  name: guid(configurationContainer.id, webIdentity.id, blobDataContributorRoleId)
  properties: {
    principalId: webIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource auditWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: auditContainer
  name: guid(auditContainer.id, webIdentity.id, blobDataContributorRoleId)
  properties: {
    principalId: webIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource inventoryWebWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: inventoryContainer
  name: guid(inventoryContainer.id, webIdentity.id, blobDataContributorRoleId)
  properties: {
    principalId: webIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource operationsWebWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: operationsContainer
  name: guid(operationsContainer.id, webIdentity.id, blobDataContributorRoleId)
  properties: {
    principalId: webIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource configurationCollectorWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: configurationContainer
  name: guid(configurationContainer.id, collectorIdentity.id, blobDataContributorRoleId)
  properties: {
    principalId: collectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource auditCollectorWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: auditContainer
  name: guid(auditContainer.id, collectorIdentity.id, blobDataContributorRoleId)
  properties: {
    principalId: collectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource inventoryCollectorWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: inventoryContainer
  name: guid(inventoryContainer.id, collectorIdentity.id, blobDataContributorRoleId)
  properties: {
    principalId: collectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource operationsCollectorWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: operationsContainer
  name: guid(operationsContainer.id, collectorIdentity.id, blobDataContributorRoleId)
  properties: {
    principalId: collectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, webIdentity.id, acrPullRoleId)
  properties: {
    principalId: webIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleId
  }
}

resource collectorRegistryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, collectorIdentity.id, acrPullRoleId)
  properties: {
    principalId: collectorIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleId
  }
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: union({
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }, usePrivateStorage ? {
    vnetConfiguration: {
      infrastructureSubnetId: containerAppsSubnet!.id
      internal: false
    }
  } : {
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
  })
}

resource authorizationSyncJob 'Microsoft.App/jobs@2025-01-01' = if (deployWebApp) {
  name: authorizationSyncJobName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${collectorIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerEnvironment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 900
      replicaRetryLimit: 2
      scheduleTriggerConfig: {
        cronExpression: '10 * * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: collectorIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'authorization-sync'
          image: containerImage
          command: [
            'node'
          ]
          args: [
            '/prod/authorization-sync/dist/index.js'
          ]
          env: [
            {
              name: 'AUTH_DISCOVERY_MODE'
              value: 'azure'
            }
            {
              name: 'MANAGING_TENANT_ID'
              value: tenant().tenantId
            }
            {
              name: 'BLOB_ACCOUNT_URL'
              value: storage.properties.primaryEndpoints.blob
            }
            {
              name: 'MANAGED_IDENTITY_CLIENT_ID'
              value: collectorIdentity.properties.clientId
            }
            {
              name: 'BLOB_AUTO_CREATE'
              value: 'false'
            }
            {
              name: 'CONFIGURATION_CONTAINER'
              value: configurationContainer.name
            }
            {
              name: 'AUDIT_CONTAINER'
              value: auditContainer.name
            }
            {
              name: 'INVENTORY_CONTAINER'
              value: inventoryContainer.name
            }
            {
              name: 'OPERATIONS_CONTAINER'
              value: operationsContainer.name
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
    }
  }
  dependsOn: [
    configurationCollectorWriter
    auditCollectorWriter
    inventoryCollectorWriter
    operationsCollectorWriter
    collectorRegistryPull
    blobPrivateDnsLink
    blobPrivateDnsZoneGroup
  ]
}

resource authorizationSyncJobOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployWebApp) {
  scope: authorizationSyncJob
  name: guid(authorizationSyncJob!.id, webIdentity.id, jobsOperatorRoleId)
  properties: {
    principalId: webIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: jobsOperatorRoleId
  }
}

module pricing './pricing.bicep' = {
  name: '${namePrefix}-pricing'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    deployWebApp: deployWebApp
    containerImage: containerImage
    storageAccountName: storage.name
    registryName: registry.name
    containerEnvironmentId: containerEnvironment.id
    webIdentityPrincipalId: webIdentity.properties.principalId
    existingStorageLifecycleRules: existingStorageLifecycleRules
  }
  dependsOn: [
    operationsContainer
    blobPrivateDnsLink
    blobPrivateDnsZoneGroup
  ]
}

module usage './usage.bicep' = {
  name: '${namePrefix}-usage'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    deployWebApp: deployWebApp
    containerImage: containerImage
    storageAccountName: storage.name
    registryName: registry.name
    containerEnvironmentId: containerEnvironment.id
    collectorIdentityName: collectorIdentity.name
    webIdentityPrincipalId: webIdentity.properties.principalId
    shardCount: usageShardCount
    tenantConcurrency: usageTenantConcurrency
    subscriptionConcurrency: usageSubscriptionConcurrency
    totalRequestConcurrency: usageRequestConcurrency
    senderMailbox: mailSenderMailbox
    allowedRecipientDomains: mailAllowedRecipientDomains
  }
  dependsOn: [pricing, inventoryCollectorWriter, operationsCollectorWriter, collectorRegistryPull]
}

module mail './mail.bicep' = {
  name: '${namePrefix}-mail'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    deployWebApp: deployWebApp
    containerImage: containerImage
    storageAccountName: storage.name
    registryName: registry.name
    containerEnvironmentId: containerEnvironment.id
    webIdentityPrincipalId: webIdentity.properties.principalId
    publicUrl: 'https://${webAppName}.${containerEnvironment.properties.defaultDomain}'
    usageShardCount: usageShardCount
    authorizationReady: mailAuthorizationReady
    senderMailbox: mailSenderMailbox
    allowedRecipientDomains: mailAllowedRecipientDomains
  }
  dependsOn: [pricing, operationsContainer, configurationContainer]
}

resource webApp 'Microsoft.App/containerApps@2025-01-01' = if (deployWebApp) {
  name: webAppName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${webIdentity.id}': {}
      '${offboardingIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnvironment.id
    configuration: {
      activeRevisionsMode: 'Multiple'
      ingress: {
        allowInsecure: false
        external: true
        targetPort: 3000
        transport: 'auto'
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: webIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: containerImage
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'AUTH_MODE'
              value: 'easyauth'
            }
            {
              name: 'BLOB_ACCOUNT_URL'
              value: storage.properties.primaryEndpoints.blob
            }
            {
              name: 'MANAGED_IDENTITY_CLIENT_ID'
              value: webIdentity.properties.clientId
            }
            {
              name: 'BLOB_AUTO_CREATE'
              value: 'false'
            }
            {
              name: 'CONFIGURATION_CONTAINER'
              value: configurationContainer.name
            }
            {
              name: 'AUDIT_CONTAINER'
              value: auditContainer.name
            }
            {
              name: 'INVENTORY_CONTAINER'
              value: inventoryContainer.name
            }
            {
              name: 'OPERATIONS_CONTAINER'
              value: operationsContainer.name
            }
            {
              name: 'AUTH_SYNC_MODE'
              value: 'job'
            }
            {
              name: 'AUTH_SYNC_JOB_SUBSCRIPTION_ID'
              value: subscription().subscriptionId
            }
            {
              name: 'AUTH_SYNC_JOB_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              name: 'AUTH_SYNC_JOB_NAME'
              value: authorizationSyncJob!.name
            }
            {
              name: 'PRICING_SYNC_MODE'
              value: 'job'
            }
            {
              name: 'PRICING_SYNC_JOB_SUBSCRIPTION_ID'
              value: subscription().subscriptionId
            }
            {
              name: 'PRICING_SYNC_JOB_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              name: 'PRICING_SYNC_JOB_NAME'
              value: pricing.outputs.pricingJobName
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsights.properties.ConnectionString
            }
            {
              name: 'USAGE_SYNC_MODE'
              value: 'job'
            }
            {
              name: 'USAGE_JOB_SUBSCRIPTION_ID'
              value: subscription().subscriptionId
            }
            {
              name: 'USAGE_JOB_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              name: 'USAGE_JOB_NAME'
              value: usage.outputs.usageJobName
            }
            {
              name: 'USAGE_SHARD_COUNT'
              value: string(usageShardCount)
            }
            {
              name: 'USAGE_REQUEST_CONCURRENCY'
              value: string(usageRequestConcurrency)
            }
            {
              name: 'PORT'
              value: '3000'
            }
            {
              name: 'MAIL_MODE'
              value: 'graph'
            }
            {
              name: 'MAIL_SENDER_MAILBOX'
              value: mailSenderMailbox
            }
            {
              name: 'MAIL_ALLOWED_DOMAINS'
              value: join(mailAllowedRecipientDomains, ',')
            }
            {
              name: 'OFFBOARDING_CLIENT_ID'
              value: offboardingIdentity.properties.clientId
            }
            {
              name: 'OFFBOARDING_PRINCIPAL_ID'
              value: offboardingIdentity.properties.principalId
            }
            {
              name: 'OFFBOARDING_MANAGING_TENANT_ID'
              value: tenant().tenantId
            }
            {
              name: 'OFFBOARDING_COLLECTOR_PRINCIPAL_ID'
              value: collectorIdentity.properties.principalId
            }
            {
              name: 'MAIL_AUTHORIZATION_READY'
              value: mailAuthorizationReady ? 'true' : 'false'
            }
            {
              name: 'MAIL_IDENTITY_CLIENT_ID'
              value: mail.outputs.mailIdentityClientId
            }
            {
              name: 'MAIL_JOB_SUBSCRIPTION_ID'
              value: subscription().subscriptionId
            }
            {
              name: 'MAIL_JOB_RESOURCE_GROUP'
              value: resourceGroup().name
            }
            {
              name: 'MAIL_JOB_NAME'
              value: mail.outputs.mailJobName
            }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health/live'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health/ready'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 5
              periodSeconds: 15
            }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
  dependsOn: [
    configurationWriter
    auditWriter
    inventoryWebWriter
    operationsWebWriter
    registryPull
    authorizationSyncJobOperator
    blobPrivateDnsLink
    blobPrivateDnsZoneGroup
  ]
}

output containerAppName string = deployWebApp ? webApp!.name : ''
output containerAppFqdn string = deployWebApp ? webApp!.properties.configuration.ingress.fqdn : ''
output storageAccountName string = storage.name
output registryName string = registry.name
output webIdentityClientId string = webIdentity.properties.clientId
output webIdentityPrincipalId string = webIdentity.properties.principalId
output collectorIdentityClientId string = collectorIdentity.properties.clientId
output collectorIdentityPrincipalId string = collectorIdentity.properties.principalId
output offboardingIdentityClientId string = offboardingIdentity.properties.clientId
output offboardingIdentityPrincipalId string = offboardingIdentity.properties.principalId
output authorizationSyncJobName string = deployWebApp ? authorizationSyncJob!.name : ''
output pricingJobName string = pricing.outputs.pricingJobName
output pricingIdentityClientId string = pricing.outputs.pricingIdentityClientId
output pricingIdentityPrincipalId string = pricing.outputs.pricingIdentityPrincipalId
output usageJobName string = usage.outputs.usageJobName
output mailJobName string = mail.outputs.mailJobName
output mailIdentityClientId string = mail.outputs.mailIdentityClientId
output mailIdentityPrincipalId string = mail.outputs.mailIdentityPrincipalId
output storageAccessMode string = storageAccessMode
output containerEnvironmentName string = containerEnvironment.name
output virtualNetworkName string = usePrivateStorage ? virtualNetwork!.name : ''
output blobPrivateEndpointName string = usePrivateStorage ? blobPrivateEndpoint!.name : ''
