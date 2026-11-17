param name string
param location string
param tags object
param insightsId string
param workspaceId string
@description('The data subnet, where every private endpoint sits.')
param subnetId string
@description('The Azure Monitor private DNS zones the endpoint registers in.')
param dnsZoneIds string[]

// Telemetry ingested privately (Microsoft's private-network Agent Service
// sample, `monitor-private-link-scope.bicep`): an Azure Monitor private link
// scope holding Application Insights and its workspace, reached through one
// private endpoint in the data subnet. Ingestion is PrivateOnly, so from
// inside the network telemetry reaches only the resources in this scope;
// query is Open, so the portal and Foundry's tracing view, outside the
// network, can still read it. The two resources refuse public ingestion
// themselves (modules/monitoring.bicep).
resource scope 'Microsoft.Insights/privateLinkScopes@2021-07-01-preview' = {
  name: name
  location: 'global'
  tags: tags
  properties: {
    accessModeSettings: {
      ingestionAccessMode: 'PrivateOnly'
      queryAccessMode: 'Open'
    }
  }
}

resource insights 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = {
  parent: scope
  name: 'insights'
  properties: { linkedResourceId: insightsId }
}

resource workspace 'Microsoft.Insights/privateLinkScopes/scopedResources@2021-07-01-preview' = {
  parent: scope
  name: 'workspace'
  properties: { linkedResourceId: workspaceId }
}

resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: 'pep-${name}'
  location: location
  tags: tags
  dependsOn: [insights, workspace]
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [
      {
        name: name
        properties: { privateLinkServiceId: scope.id, groupIds: ['azuremonitor'] }
      }
    ]
  }
}

resource zoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      for (zone, i) in dnsZoneIds: {
        name: last(split(zone, '/'))
        properties: { privateDnsZoneId: zone }
      }
    ]
  }
}
