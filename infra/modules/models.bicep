import { publicAccess, RoleAssignment } from '../types.bicep'

param name string
param location string
param tags object
param workspaceId string
@description('The deployments to make, by role: `Models`, one per role that is set.')
param models object
param private bool
param privateEndpoints array
@description('The subnet the Agent Service is injected into; empty runs it on Microsoft\'s network.')
param agentSubnetId string
param roleAssignments RoleAssignment[]

// A Foundry (AIServices) account. It began as an Azure OpenAI account of the
// same name, and an existing one is upgraded in place by this template: the
// kind, a system identity and project management are what the upgrade asks
// for, and its endpoint (<name>.openai.azure.com, which the apps call), its
// deployments and its keyless setting are kept.
//
// No key: every caller presents an Entra token. Versions are pinned and never
// auto-upgraded, so a retirement is caught by model-deprecations.test.ts
// rather than by a silent move. Outbound access is not restricted: the Agent
// Service reaches Cosmos DB, Storage and AI Search from the account, as
// Microsoft's standard agent setup leaves it.
module account 'br/public:avm/res/cognitive-services/account:0.19.1' = {
  name: 'foundry-account'
  params: {
    name: name
    location: location
    tags: tags
    kind: 'AIServices'
    sku: 'S0'
    customSubDomainName: name
    disableLocalAuth: true
    allowProjectManagement: true
    managedIdentities: { systemAssigned: true }
    restrictOutboundNetworkAccess: false
    publicNetworkAccess: publicAccess(private)
    // Hardened, AI Search reaches the account as a trusted service, as its own
    // identity: its indexer's OCR and embeddings, its vectorizer, and a
    // knowledge base's planning model.
    networkAcls: { bypass: 'AzureServices', defaultAction: private ? 'Deny' : 'Allow' }
    networkInjections: empty(agentSubnetId)
      ? null
      : { scenario: 'agent', subnetResourceId: agentSubnetId, useMicrosoftManagedNetwork: false }
    privateEndpoints: privateEndpoints
    roleAssignments: roleAssignments
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

resource foundry 'Microsoft.CognitiveServices/accounts@2025-12-01' existing = {
  name: name
}

// The guardrail on every deployment and every agent version: Microsoft's
// DefaultV2, written out in full, plus Prompt Shields for indirect (document)
// attacks, which DefaultV2 leaves off. A policy declares every filter it
// keeps, so the defaults are spelt here rather than inherited.
var harms = ['Hate', 'Sexual', 'Violence', 'Selfharm']
resource guardrail 'Microsoft.CognitiveServices/accounts/raiPolicies@2025-12-01' = {
  parent: foundry
  name: 'default-indirect'
  dependsOn: [account]
  properties: {
    basePolicyName: 'Microsoft.DefaultV2'
    contentFilters: concat(
      flatten(map(
        harms,
        harm =>
          map(['Prompt', 'Completion'], source => {
            name: harm
            severityThreshold: 'Medium'
            blocking: true
            enabled: true
            source: source
          })
      )),
      [
        { name: 'Jailbreak', blocking: true, enabled: true, source: 'Prompt' }
        { name: 'Indirect Attack', blocking: true, enabled: true, source: 'Prompt' }
        { name: 'Protected Material Text', blocking: true, enabled: true, source: 'Completion' }
        { name: 'Protected Material Code', blocking: true, enabled: true, source: 'Completion' }
      ]
    )
  }
}

// One at a time: the account takes one change at once. Every role that is
// set, so `realtime` is a deployment only when the parameter gives it.
@batchSize(1)
resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2025-12-01' = [
  for role in filter(items(models), role => role.value != null): {
    parent: foundry
    name: role.value.name
    sku: { name: role.value.sku, capacity: role.value.capacity }
    properties: {
      model: { format: 'OpenAI', name: role.value.model, version: role.value.version }
      versionUpgradeOption: 'NoAutoUpgrade'
      raiPolicyName: guardrail.name
    }
  }
]

output name string = account.outputs.name
output endpoint string = account.outputs.endpoint
@description('The guardrail every agent version names in its rai_config, by resource id: the service refuses a bare name there.')
output guardrail string = guardrail.id
