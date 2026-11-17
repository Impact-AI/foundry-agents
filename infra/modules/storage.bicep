import { publicAccess, RoleAssignment } from '../types.bicep'

param name string
param location string
param tags object
param workspaceId string
param lock bool
param zoneRedundant bool
param private bool
param privateEndpoints array
param roleAssignments RoleAssignment[]

// Keyless: the identities hold Storage Blob Data roles and the account key
// stays unusable. No browser ever reads a blob — the backend streams a
// picture it read itself — so with private networking the account is behind
// its private endpoint like every other data service, and the ingest script
// uploads a library from inside the network. `library` holds every library,
// each under its name: the files, and their descriptions in each blob's
// metadata, which AI Search's indexer reads with its own identity. Deleted
// blobs are kept a week, which is what the indexer's deletion detection
// finds a removed file by. `appearance` holds the deployment's logo, apart
// from the library so the indexer never reads it, which the backend serves
// to the sign-in door and the bar.
var libraryContainer = 'library'
var appearanceContainer = 'appearance'
module account 'br/public:avm/res/storage/storage-account:0.33.1' = {
  name: 'storage-account'
  params: {
    name: name
    location: location
    tags: tags
    kind: 'StorageV2'
    skuName: zoneRedundant ? 'Standard_ZRS' : 'Standard_LRS'
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowBlobPublicAccess: false
    publicNetworkAccess: publicAccess(private)
    networkAcls: { bypass: 'AzureServices', defaultAction: private ? 'Deny' : 'Allow' }
    privateEndpoints: privateEndpoints
    blobServices: {
      deleteRetentionPolicyEnabled: true
      deleteRetentionPolicyDays: 7
      containerDeleteRetentionPolicyEnabled: true
      containerDeleteRetentionPolicyDays: 7
      containers: [
        { name: libraryContainer, publicAccess: 'None' }
        { name: appearanceContainer, publicAccess: 'None' }
      ]
    }
    roleAssignments: roleAssignments
    lock: lock ? { kind: 'CanNotDelete' } : null
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

output name string = account.outputs.name
output resourceId string = account.outputs.resourceId
output libraryContainer string = libraryContainer
output appearanceContainer string = appearanceContainer
