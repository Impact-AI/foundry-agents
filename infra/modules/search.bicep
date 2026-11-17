import { publicAccess, RoleAssignment } from '../types.bicep'

param name string
param location string
param tags object
param workspaceId string
param lock bool
param sku string
@description('How many replicas the service runs: from two it spreads them over availability zones where the region has them.')
param replicas int
param private bool
param privateEndpoints array
param roleAssignments RoleAssignment[]

module service 'br/public:avm/res/search/search-service:0.13.0' = {
  name: 'search-service'
  params: {
    name: name
    location: location
    tags: tags
    sku: sku
    replicaCount: replicas
    partitionCount: 1
    disableLocalAuth: true
    publicNetworkAccess: publicAccess(private)
    // The billed plan: the free one caps the reranker per month and then
    // degrades relevance silently rather than erroring.
    semanticSearch: 'standard'
    // Its own identity is the one its indexer reads Storage and calls the
    // Foundry account with.
    managedIdentities: { systemAssigned: true }
    privateEndpoints: privateEndpoints
    roleAssignments: roleAssignments
    lock: lock ? { kind: 'CanNotDelete' } : null
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

output name string = service.outputs.name
output endpoint string = service.outputs.endpoint
output principalId string = service.outputs.systemAssignedMIPrincipalId!
