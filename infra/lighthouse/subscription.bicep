targetScope = 'subscription'

@description('Microsoft Entra tenant ID of the AOAI Cost managing tenant.')
param managedByTenantId string

@description('Object ID of the collector service principal in the managing tenant.')
param collectorPrincipalId string

@description('Object ID of the separate offboarding managed identity. Grants only registration-assignment deletion; the Collector remains Reader.')
param offboardingPrincipalId string

@description('Display name shown to the customer for this delegation.')
param mspOfferName string = 'AOAI Cost Usage Monitoring'

@description('Description shown to the customer for this delegation.')
param mspOfferDescription string = 'Read-only discovery and Azure Monitor metrics collection for Azure OpenAI cost estimation.'

var readerRoleDefinitionId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
var deleteAssignmentRoleDefinitionId = '91c1777a-f3dc-4fae-b103-61d183457e46'
var registrationDefinitionName = guid(
  managedByTenantId,
  collectorPrincipalId,
  subscription().subscriptionId,
  mspOfferName
)

resource registrationDefinition 'Microsoft.ManagedServices/registrationDefinitions@2022-10-01' = {
  name: registrationDefinitionName
  properties: {
    registrationDefinitionName: mspOfferName
    description: mspOfferDescription
    managedByTenantId: managedByTenantId
    authorizations: [
      {
        principalId: collectorPrincipalId
        principalIdDisplayName: 'AOAI Cost Collector'
        roleDefinitionId: readerRoleDefinitionId
      }
      {
        principalId: offboardingPrincipalId
        principalIdDisplayName: 'AOAI Cost Offboarding'
        roleDefinitionId: deleteAssignmentRoleDefinitionId
      }
    ]
  }
}

resource registrationAssignment 'Microsoft.ManagedServices/registrationAssignments@2022-10-01' = {
  name: guid(subscription().subscriptionId, registrationDefinitionName)
  properties: {
    registrationDefinitionId: registrationDefinition.id
  }
}

output registrationDefinitionId string = registrationDefinition.id
output registrationAssignmentId string = registrationAssignment.id
output delegatedSubscriptionId string = subscription().subscriptionId
output offboardingIdentityObjectId string = offboardingPrincipalId
