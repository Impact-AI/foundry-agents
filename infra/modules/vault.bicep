import { publicAccess, RoleAssignment } from '../types.bicep'

param name string
param location string
param tags object
param workspaceId string
param lock bool
param purgeProtection bool
param private bool
param privateEndpoints array
param roleAssignments RoleAssignment[]

@secure()
param authSecret string
param entraClientId string
@secure()
param entraClientSecret string
param entraIssuer string
@description('The product\'s ingest key in impact.ai, which both apps copy their spans with.')
@secure()
param impactApiKey string
@description('The names of the secrets the vault already holds.')
param held string[]

// The apps reference every secret by name at creation, so each exists from
// the first provision; a sign-in value nobody has set yet is a placeholder
// that fails the sign-in, not the deployment, and an ingest key nobody has
// set is a placeholder the apps read as no key, copying nothing to
// impact.ai. A placeholder is written only
// while the vault does not hold the secret: a provision whose environment
// carries no value for one leaves the vault's alone, whether it was set by an
// earlier provision or rotated in the vault. The secrets are written through
// the control plane, so a vault with its public listener off still gets them.
func secret(name string, value string) object => { name: name, value: empty(value) ? 'unset' : value }
// The session secret has no placeholder: both apps sign with it, so a vault
// that holds none and a provision that carries none is refused here, by
// name, before anything is written. preprovision makes one in exactly that
// case, so this is a provision run without its hook.
var sessionSecret = empty(authSecret) && !contains(held, 'auth-secret')
  ? fail('AUTH_SECRET is empty and the vault holds no auth-secret. Set one (azd env set AUTH_SECRET <32 or more characters>), or provision through azd, whose preprovision hook makes it.')
  : authSecret
var wanted = [
  { name: 'auth-secret', value: sessionSecret }
  { name: 'entra-client-id', value: entraClientId }
  { name: 'entra-client-secret', value: entraClientSecret }
  { name: 'entra-issuer', value: entraIssuer }
  { name: 'impact-api-key', value: impactApiKey }
]
var written = filter(wanted, s => !empty(s.value) || !contains(held, s.name))

module vault 'br/public:avm/res/key-vault/vault:0.14.2' = {
  name: 'key-vault'
  params: {
    name: name
    location: location
    tags: tags
    sku: 'standard'
    enableRbacAuthorization: true
    enablePurgeProtection: purgeProtection
    softDeleteRetentionInDays: 7
    publicNetworkAccess: publicAccess(private)
    networkAcls: { bypass: 'AzureServices', defaultAction: private ? 'Deny' : 'Allow' }
    secrets: map(written, s => secret(s.name, s.value))
    privateEndpoints: privateEndpoints
    roleAssignments: roleAssignments
    lock: lock ? { kind: 'CanNotDelete' } : null
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

output name string = vault.outputs.name
output uri string = vault.outputs.uri
