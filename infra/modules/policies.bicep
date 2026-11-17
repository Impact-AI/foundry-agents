@description('The names the assignments are listed under, so they read as this deployment\'s in a subscription\'s compliance view.')
param displayPrefix string
@description('Whether the data services sit behind private endpoints: the public-access audits apply only then.')
param private bool

// Built-in Azure Policy definitions assigned to the resource group in Audit,
// following the Foundry baseline reference architecture's
// `azure-policies.bicep`. Audit reports a resource out of compliance and
// changes nothing; a Deny would stop a provision. Local authentication is off
// on every one of these services in both modes, so those four audit both. The
// public-access audits apply only with private networking: a demo's endpoints
// are public by design, and an audit that is always non-compliant reports
// nothing.
var audits = [
  { id: '71ef260a-8f18-47b7-abcb-62d0673d94dc', what: 'Foundry account local authentication disabled', network: false }
  { id: '5450f5bd-9c72-4390-a9c4-a7aba4edfdd2', what: 'Cosmos DB local authentication disabled', network: false }
  { id: '6300012e-e9a4-4649-b41f-a85f5c43be91', what: 'AI Search local authentication disabled', network: false }
  { id: '8c6a50c6-9ffd-4ae7-986f-5fa6111f9a54', what: 'Storage shared key access prevented', network: false }
  { id: '037eea7a-bd0a-46c5-9a66-03aea78705d3', what: 'Foundry account network access restricted', network: true }
  { id: '797b37f7-06b8-444c-b1ad-fc62867f335a', what: 'Cosmos DB public network access disabled', network: true }
  { id: 'ee980b6d-0eca-4501-8d54-f6290fd512c3', what: 'AI Search public network access disabled', network: true }
  { id: 'b2982f36-99f2-4db5-8eff-283140c09693', what: 'Storage public network access disabled', network: true }
]

resource assignments 'Microsoft.Authorization/policyAssignments@2024-04-01' = [
  for audit in filter(audits, a => private || !a.network): {
    name: guid(resourceGroup().id, audit.id)
    properties: {
      displayName: '${displayPrefix}: ${audit.what}'
      policyDefinitionId: tenantResourceId('Microsoft.Authorization/policyDefinitions', audit.id)
      enforcementMode: 'Default'
      parameters: { effect: { value: 'Audit' } }
    }
  }
]
