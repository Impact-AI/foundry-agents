import { Identity } from '../types.bicep'

param backendName string
param frontendName string
param migrateName string
param location string
param tags object

// One identity per thing that runs, each with its own role list in main.bicep.
// The migrate job's is separate from the backend's because it holds what the
// backend must not: the settings documents, the search pipeline and the
// library's blobs to write, Prompt Shields to call.
module backendIdentity 'br/public:avm/res/managed-identity/user-assigned-identity:0.6.0' = {
  name: 'backend-identity'
  params: { name: backendName, location: location, tags: tags }
}

module frontendIdentity 'br/public:avm/res/managed-identity/user-assigned-identity:0.6.0' = {
  name: 'frontend-identity'
  params: { name: frontendName, location: location, tags: tags }
}

module migrateIdentity 'br/public:avm/res/managed-identity/user-assigned-identity:0.6.0' = {
  name: 'migrate-identity'
  params: { name: migrateName, location: location, tags: tags }
}

output backend Identity = {
  name: backendIdentity.outputs.name
  resourceId: backendIdentity.outputs.resourceId
  principalId: backendIdentity.outputs.principalId
  clientId: backendIdentity.outputs.clientId
}

output frontend Identity = {
  name: frontendIdentity.outputs.name
  resourceId: frontendIdentity.outputs.resourceId
  principalId: frontendIdentity.outputs.principalId
  clientId: frontendIdentity.outputs.clientId
}

output migrate Identity = {
  name: migrateIdentity.outputs.name
  resourceId: migrateIdentity.outputs.resourceId
  principalId: migrateIdentity.outputs.principalId
  clientId: migrateIdentity.outputs.clientId
}
