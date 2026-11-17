param accountName string
param projectName string
param projectPrincipalId string
@description('The project\'s workspace id as a GUID: the prefix of the containers the Agent Service makes in Storage.')
param projectWorkspaceId string
@description('The project\'s connections the service keeps its state in: threads, files, vectors.')
param connections { threads: string, files: string, vectors: string }
param cosmosName string
param storageName string
param searchName string
@description('Whether the account is injected into a subnet. Injection creates the account\'s capability host itself; without it the template does.')
param injected bool

// The Foundry Agent Service's standard setup, in the order Microsoft's
// template makes it: the project's identity gets its roles on the three
// stores, then the capability hosts bind the project to its connections, and
// only then does the identity get the narrower roles on what the service has
// just created (the `enterprise_memory` database and the agent containers).

// Built-in role ids.
var cosmosOperator = '230815da-be43-4aae-9cb4-875f7bd000aa'
var blobContributor = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var indexContributor = '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
var serviceContributor = '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
var cosmosDataContributor = '00000000-0000-0000-0000-000000000002'
var openAiUser = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource account 'Microsoft.CognitiveServices/accounts@2025-12-01' existing = {
  name: accountName
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-12-01' existing = {
  parent: account
  name: projectName
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

func role(id string) string => subscriptionResourceId('Microsoft.Authorization/roleDefinitions', id)

resource cosmosRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: cosmos
  name: guid(cosmos.id, projectPrincipalId, cosmosOperator)
  properties: { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: role(cosmosOperator) }
}

resource storageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, projectPrincipalId, blobContributor)
  properties: { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: role(blobContributor) }
}

// Search Service Contributor lets the service make and change indexes on the
// one search service the deployment has, which it shares with retrieval.
resource searchRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for id in [indexContributor, serviceContributor]: {
    scope: search
    name: guid(search.id, projectPrincipalId, id)
    properties: { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: role(id) }
  }
]

// The memory store (preview, `memory.store: "foundry"`) extracts and recalls
// through the account's deployments as the project; without this its updates
// fail with a 401 from the model. Granted whichever store the operator's
// document names, so a flip of the setting is never a provision.
resource modelsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: account
  name: guid(account.id, projectPrincipalId, openAiUser)
  properties: { principalId: projectPrincipalId, principalType: 'ServicePrincipal', roleDefinitionId: role(openAiUser) }
}

// An injected account gets its capability host from the injection; one more
// is refused, since an account holds one. The injection's own name,
// `<account>@aml_aiagentservice`, is refused in a request: `@` is not allowed.
resource accountHost 'Microsoft.CognitiveServices/accounts/capabilityHosts@2025-12-01' = if (!injected) {
  parent: account
  name: 'agents'
  properties: { capabilityHostKind: 'Agents' }
}

resource projectHost 'Microsoft.CognitiveServices/accounts/projects/capabilityHosts@2025-12-01' = {
  parent: project
  name: 'agents'
  dependsOn: [cosmosRole, storageRole, searchRoles, accountHost]
  properties: {
    // The type definitions omit the kind the service requires.
    #disable-next-line BCP037
    capabilityHostKind: 'Agents'
    threadStorageConnections: [connections.threads]
    storageConnections: [connections.files]
    vectorStoreConnections: [connections.vectors]
  }
}

// Read and write in the database the capability host made, and no other.
resource threadsRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2025-04-15' = {
  parent: cosmos
  name: guid(cosmos.id, projectPrincipalId, 'enterprise_memory')
  dependsOn: [projectHost]
  properties: {
    principalId: projectPrincipalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/${cosmosDataContributor}'
    scope: '${cosmos.id}/dbs/enterprise_memory'
  }
}

// What Owner adds to the Contributor role above is blob tags; the condition,
// Microsoft's, keeps those to the service's own containers: named for the
// project's workspace and ending `-azureml-agent`.
resource filesRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, projectPrincipalId, blobOwner)
  dependsOn: [projectHost]
  properties: {
    principalId: projectPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: role(blobOwner)
    conditionVersion: '2.0'
    condition: '((!(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/read\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/filter/action\'}) AND !(ActionMatches{\'Microsoft.Storage/storageAccounts/blobServices/containers/blobs/tags/write\'})) OR (@Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringStartsWithIgnoreCase \'${projectWorkspaceId}\' AND @Resource[Microsoft.Storage/storageAccounts/blobServices/containers:name] StringLikeIgnoreCase \'*-azureml-agent\'))'
  }
}
