param name string
param location string
param tags object
param workspaceId string
@description('The delegated subnet the environment joins; null keeps it off any network, the demo shape.')
param appsSubnetId string?
param zoneRedundant bool
@description('True closes the environment\'s public ingress; only a private link, Front Door\'s, reaches it.')
param privateLinkOnly bool

module environment 'br/public:avm/res/app/managed-environment:0.16.0' = {
  name: 'apps-environment'
  params: {
    name: name
    location: location
    tags: tags
    infrastructureSubnetResourceId: appsSubnetId
    internal: false
    zoneRedundant: zoneRedundant
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    publicNetworkAccess: privateLinkOnly ? 'Disabled' : 'Enabled'
    appLogsConfiguration: { destination: 'azure-monitor' }
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

output resourceId string = environment.outputs.resourceId
output name string = environment.outputs.name
output defaultDomain string = environment.outputs.defaultDomain
