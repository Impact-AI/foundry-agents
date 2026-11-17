param workspaceName string
param insightsName string
param location string
param tags object
@description('Refuse ingestion from the public internet: telemetry arrives through the private link scope alone. Query stays public, so the portal reads it.')
param privateIngestion bool

var ingestion = privateIngestion ? 'Disabled' : 'Enabled'

module workspace 'br/public:avm/res/operational-insights/workspace:0.16.1' = {
  name: 'workspace'
  params: {
    name: workspaceName
    location: location
    tags: tags
    skuName: 'PerGB2018'
    dataRetention: 30
    publicNetworkAccessForIngestion: ingestion
    publicNetworkAccessForQuery: 'Enabled'
  }
}

module insights 'br/public:avm/res/insights/component:0.8.0' = {
  name: 'insights'
  params: {
    name: insightsName
    location: location
    tags: tags
    workspaceResourceId: workspace.outputs.resourceId
    applicationType: 'web'
    kind: 'web'
    retentionInDays: 30
    publicNetworkAccessForIngestion: ingestion
    publicNetworkAccessForQuery: 'Enabled'
    // Its logs already land in the workspace it is based on; a log setting to the same
    // workspace writes every App* row twice. Metrics only.
    diagnosticSettings: [{ workspaceResourceId: workspace.outputs.resourceId, logCategoriesAndGroups: [] }]
  }
}

output workspaceId string = workspace.outputs.resourceId
output insightsId string = insights.outputs.resourceId
output insightsName string = insights.outputs.name
output insightsConnectionString string = insights.outputs.connectionString
