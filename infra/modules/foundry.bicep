import { RoleAssignment } from '../types.bicep'

param accountName string
param location string
param tags object
param cosmosName string
param storageName string
param searchName string
param insightsName string
@description('Connect the project to Application Insights. The connection is the switch for the Agent Service\'s own traces, which carry what each turn was asked and what it answered.')
param agentTracing bool
@description('Who may use the project: create agent versions, conversations and responses. Scoped to the project, never the account.')
param projectUsers RoleAssignment[]

// The Foundry project the agent lives in, and its connections: the three the
// Agent Service's standard setup keeps its state in (threads in Cosmos DB,
// files in Storage, vector stores in AI Search, all reached with the
// project's own identity) and, only when asked for, Application Insights
// for its traces. Web search is the service's own tool, which needs no
// resource of the deployment's.
var projectName = 'agent'

resource account 'Microsoft.CognitiveServices/accounts@2025-12-01' existing = {
  name: accountName
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2025-04-15' existing = {
  name: cosmosName
}

resource storage 'Microsoft.Storage/storageAccounts@2025-01-01' existing = {
  name: storageName
}

resource search 'Microsoft.Search/searchServices@2025-05-01' existing = {
  name: searchName
}

resource insights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: insightsName
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-12-01' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {}
}

// The standard setup refuses a connection without metadata.ResourceId, and
// Cosmos DB takes only Entra (AAD).
//
// The four connections are made one after another, each waiting for the one
// before it: the service conflicts on writes to one project's connections made
// in parallel, which surfaces as a failed provision rather than a retry. The
// Foundry baseline reference architecture chains its connections for the same
// reason.
func entraConnection(category string, target string, id string, location string) object => {
  category: category
  target: target
  authType: 'AAD'
  metadata: { ApiType: 'Azure', ResourceId: id, location: location }
}

resource cosmosConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-12-01' = {
  parent: project
  name: 'cosmos'
  properties: entraConnection('CosmosDB', cosmos.properties.documentEndpoint, cosmos.id, cosmos.location)
}

resource storageConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-12-01' = {
  parent: project
  name: 'storage'
  dependsOn: [cosmosConnection]
  properties: entraConnection('AzureStorageAccount', storage.properties.primaryEndpoints.blob, storage.id, storage.location)
}

resource searchConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-12-01' = {
  parent: project
  name: 'search'
  dependsOn: [storageConnection]
  properties: entraConnection('CognitiveSearch', 'https://${search.name}.search.windows.net', search.id, search.location)
}

// The service traces every agent of a project that has this connection, with
// no code of the apps' involved, and a trace holds the turn's words: what the
// person asked, what the model answered, each tool's arguments and results.
// Nothing the apps scrub passes through it, and neither a conversation's
// delete nor an account's erase reaches the workspace it lands in. So the
// connection is made only when the deployment asks for it; made, the traces
// go to the deployment's own Application Insights, by its ingestion
// connection string, read here.
resource insightsConnection 'Microsoft.CognitiveServices/accounts/projects/connections@2025-12-01' = if (agentTracing) {
  parent: project
  name: 'insights'
  dependsOn: [searchConnection]
  properties: {
    category: 'AppInsights'
    target: insights.id
    authType: 'ApiKey'
    credentials: { key: insights.properties.ConnectionString }
    metadata: { ApiType: 'Azure', ResourceId: insights.id }
  }
}

resource projectRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for user in projectUsers: {
    scope: project
    name: guid(project.id, user.principalId, user.roleDefinitionIdOrName)
    properties: {
      principalId: user.principalId
      principalType: user.principalType
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', user.roleDefinitionIdOrName)
    }
  }
]

// The project's workspace id: the prefix, written as a GUID, of the
// containers the Agent Service makes in Storage.
#disable-next-line BCP053
var internalId = project.properties.internalId

output name string = project.name
output principalId string = project.identity.principalId
output workspaceId string = '${substring(internalId, 0, 8)}-${substring(internalId, 8, 4)}-${substring(internalId, 12, 4)}-${substring(internalId, 16, 4)}-${substring(internalId, 20, 12)}'
output endpoint string = 'https://${accountName}.services.ai.azure.com/api/projects/${project.name}'
output connections object = {
  threads: cosmosConnection.name
  files: storageConnection.name
  vectors: searchConnection.name
}
