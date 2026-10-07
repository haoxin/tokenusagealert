targetScope = 'resourceGroup'

param location string

@minLength(3)
@maxLength(18)
param namePrefix string

param tags object
param deployWebApp bool
param containerImage string
param storageAccountName string
param registryName string
param containerEnvironmentId string
param webIdentityPrincipalId string

@description('Current storage lifecycle policy rules, including cloud-only rules. Pass [] only after confirming no policy exists.')
param existingStorageLifecycleRules array

var pricingJobName = '${namePrefix}-pricing-sync'
var pricingContainerNames = [
  'pricing-current'
  'pricing-history'
]
var blobDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)
var blobDataReaderRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
)
var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var jobsOperatorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b'
)
var pricingLifecycleRules = [
  {
    name: 'mail-archive-retention'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: ['operations/outbox/archive/'] }
      actions: {
        baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } }
        version: { delete: { daysAfterCreationGreaterThan: 30 } }
      }
    }
  }
  {
    name: 'mail-events-retention'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: ['operations/alert-events/', 'operations/alerting-audit/'] }
      actions: {
        baseBlob: { delete: { daysAfterModificationGreaterThan: 90 } }
        version: { delete: { daysAfterCreationGreaterThan: 90 } }
      }
    }
  }
  {
    name: 'mail-runs-retention'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: ['operations/runs/mail/history/'] }
      actions: {
        baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } }
        version: { delete: { daysAfterCreationGreaterThan: 30 } }
      }
    }
  }
  {
    name: 'usage-history-retention'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: ['usage/'] }
      actions: {
        baseBlob: { delete: { daysAfterModificationGreaterThan: 11 } }
        version: { delete: { daysAfterCreationGreaterThan: 11 } }
      }
    }
  }
  {
    name: 'usage-run-history-retention'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: { blobTypes: ['blockBlob'], prefixMatch: ['operations/runs/usage/history/'] }
      actions: {
        baseBlob: { delete: { daysAfterModificationGreaterThan: 30 } }
        version: { delete: { daysAfterCreationGreaterThan: 30 } }
      }
    }
  }
  {
    name: 'pricing-history-retention'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: {
        blobTypes: [
          'blockBlob'
        ]
        prefixMatch: [
          'pricing-history/'
        ]
      }
      actions: {
        baseBlob: {
          delete: {
            daysAfterModificationGreaterThan: 90
          }
        }
        version: {
          delete: {
            daysAfterCreationGreaterThan: 90
          }
        }
      }
    }
  }
  {
    name: 'pricing-current-version-retention'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: {
        blobTypes: [
          'blockBlob'
        ]
        prefixMatch: [
          'pricing-current/'
        ]
      }
      actions: {
        version: {
          delete: {
            daysAfterCreationGreaterThan: 30
          }
        }
      }
    }
  }
  {
    name: 'pricing-run-history-retention'
    enabled: true
    type: 'Lifecycle'
    definition: {
      filters: {
        blobTypes: [
          'blockBlob'
        ]
        prefixMatch: [
          'operations/runs/pricing/history/'
        ]
      }
      actions: {
        baseBlob: {
          delete: {
            daysAfterModificationGreaterThan: 30
          }
        }
        version: {
          delete: {
            daysAfterCreationGreaterThan: 30
          }
        }
      }
    }
  }
]
var pricingLifecycleRuleNames = map(pricingLifecycleRules, rule => rule.name)
var retainedStorageLifecycleRules = filter(
  existingStorageLifecycleRules,
  rule => !contains(pricingLifecycleRuleNames, rule.name)
)

resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' existing = {
  parent: storage
  name: 'default'
}

resource operationsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' existing = {
  parent: blobService
  name: 'operations'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource pricingIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: '${namePrefix}-pricing-id'
  location: location
  tags: tags
}

resource pricingContainers 'Microsoft.Storage/storageAccounts/blobServices/containers@2025-01-01' = [
  for containerName in pricingContainerNames: {
    parent: blobService
    name: containerName
    properties: {
      publicAccess: 'None'
    }
  }
]

resource pricingWriters 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for index in range(0, length(pricingContainerNames)): {
    scope: pricingContainers[index]
    name: guid(pricingContainers[index].id, pricingIdentity.id, blobDataContributorRoleId)
    properties: {
      principalId: pricingIdentity.properties.principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: blobDataContributorRoleId
    }
  }
]

resource pricingReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for index in range(0, length(pricingContainerNames)): {
    scope: pricingContainers[index]
    name: guid(pricingContainers[index].id, webIdentityPrincipalId, blobDataReaderRoleId)
    properties: {
      principalId: webIdentityPrincipalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: blobDataReaderRoleId
    }
  }
]

resource operationsPricingWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: operationsContainer
  name: guid(operationsContainer.id, pricingIdentity.id, blobDataContributorRoleId)
  properties: {
    principalId: pricingIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: blobDataContributorRoleId
  }
}

resource pricingRegistryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, pricingIdentity.id, acrPullRoleId)
  properties: {
    principalId: pricingIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRoleId
  }
}

resource storageLifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2025-01-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: concat(retainedStorageLifecycleRules, pricingLifecycleRules)
    }
  }
}

resource pricingJob 'Microsoft.App/jobs@2025-01-01' = if (deployWebApp) {
  name: pricingJobName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pricingIdentity.id}': {}
    }
  }
  properties: {
    environmentId: containerEnvironmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      scheduleTriggerConfig: {
        cronExpression: '0 16 * * *'
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: pricingIdentity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'pricing-sync'
          image: containerImage
          command: [
            'node'
          ]
          args: [
            '/prod/pricing-sync/dist/index.js'
          ]
          env: [
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              name: 'PRICING_SOURCE'
              value: 'azure-retail'
            }
            {
              name: 'BLOB_ACCOUNT_URL'
              value: storage.properties.primaryEndpoints.blob
            }
            {
              name: 'MANAGED_IDENTITY_CLIENT_ID'
              value: pricingIdentity.properties.clientId
            }
            {
              name: 'BLOB_AUTO_CREATE'
              value: 'false'
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
    pricingWriters
    operationsPricingWriter
    pricingRegistryPull
  ]
}

resource pricingJobOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployWebApp) {
  scope: pricingJob
  name: guid(pricingJob!.id, webIdentityPrincipalId, jobsOperatorRoleId)
  properties: {
    principalId: webIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: jobsOperatorRoleId
  }
}

output pricingJobName string = deployWebApp ? pricingJob!.name : ''
output pricingIdentityClientId string = pricingIdentity.properties.clientId
output pricingIdentityPrincipalId string = pricingIdentity.properties.principalId
