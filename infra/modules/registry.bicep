import { RoleAssignment } from '../types.bicep'

param name string
param location string
param tags object
param workspaceId string
param roleAssignments RoleAssignment[]

module registry 'br/public:avm/res/container-registry/registry:0.13.1' = {
  name: 'container-registry'
  params: {
    name: name
    location: location
    tags: tags
    acrSku: 'Basic'
    acrAdminUserEnabled: false
    zoneRedundancy: 'Disabled'
    publicNetworkAccess: 'Enabled'
    // The module's default, Deny, writes a network rule set, which Basic refuses.
    networkRuleSetDefaultAction: 'Allow'
    roleAssignments: roleAssignments
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

output loginServer string = registry.outputs.loginServer
