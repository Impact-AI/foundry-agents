import { publicAccess, RoleAssignment } from '../types.bicep'

param name string
param location string
param tags object
param workspaceId string
param lock bool
param private bool
param privateEndpoints array
param roleAssignments RoleAssignment[]

// The settings documents are written by the migrate job, inside the network,
// with its own identity's token: the store takes no key-values at creation
// without local authentication, which stays off.
module store 'br/public:avm/res/app-configuration/configuration-store:0.10.1' = {
  name: 'settings-store'
  params: {
    name: name
    location: location
    tags: tags
    sku: 'Standard'
    disableLocalAuth: true
    enablePurgeProtection: false
    softDeleteRetentionInDays: 1
    publicNetworkAccess: publicAccess(private)
    privateEndpoints: privateEndpoints
    roleAssignments: roleAssignments
    lock: lock ? { kind: 'CanNotDelete' } : null
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

output name string = store.outputs.name
output endpoint string = store.outputs.endpoint
