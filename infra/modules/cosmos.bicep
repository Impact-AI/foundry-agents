import { publicAccess } from '../types.bicep'

param name string
param location string
param tags object
param workspaceId string
param lock bool
@description('Provisioned throughput and zone redundancy; off, the account is serverless in one zone. Neither can be changed once the account exists.')
param zoneRedundant bool
param private bool
param privateEndpoints array
@description('Object ids that read and write the app\'s database, and nothing else.')
param appContributors string[]
@description('Object ids that read every database, to inspect data and verify an erasure.')
param readers string[]

// Cosmos DB for NoSQL, Entra only. It holds two databases: `app`, declared
// here, and `enterprise_memory`, which the Foundry Agent Service creates for
// its threads (three containers) when its capability host is made. Serverless
// is the demo's; the zone-redundant shape is provisioned, because serverless
// offers no zone redundancy, and `app` then shares one autoscaled budget.
var appDatabase = 'app'

// Indexing is a write cost on every document, so each container indexes what
// it is queried by: a person's free text is never indexed, and the
// ownership claims are only ever read by id.
var containers = [
  {
    // Time to live is on with no default: a document lives until deleted
    // unless it names its own `ttl`, as a short-lived marker does.
    name: 'accounts'
    paths: ['/id']
    defaultTtl: -1
    indexingPolicy: {
      includedPaths: [{ path: '/*' }]
      excludedPaths: [{ path: '/about/?' }, { path: '/preferences/?' }, { path: '/"_etag"/?' }]
    }
  }
  {
    // A person's conversations, newest first, paged by (updatedAt, id).
    name: 'threads'
    paths: ['/resourceId']
    indexingPolicy: {
      includedPaths: [{ path: '/*' }]
      excludedPaths: [{ path: '/"_etag"/?' }]
      compositeIndexes: [
        [{ path: '/updatedAt', order: 'descending' }, { path: '/id', order: 'descending' }]
      ]
    }
  }
  {
    // Each conversation's history, an item a document, read by thread in the
    // order it was written (`platform/agent/src/foundry/history.ts`). Only
    // those two fields are indexed: the words are never.
    name: 'messages'
    paths: ['/resourceId']
    indexingPolicy: {
      includedPaths: [{ path: '/threadId/?' }, { path: '/seq/?' }]
      excludedPaths: [{ path: '/*' }]
    }
  }
  {
    // What is remembered about a person, a fact a document, read as one
    // partition (`platform/agent/src/memory/store.ts`): no word of it is indexed.
    name: 'memory'
    paths: ['/resourceId']
    indexingPolicy: { includedPaths: [], excludedPaths: [{ path: '/*' }] }
  }
  {
    // The global claim on a conversation id: point reads only.
    name: 'threadIds'
    paths: ['/id']
    indexingPolicy: { includedPaths: [], excludedPaths: [{ path: '/*' }] }
  }
  {
    name: 'prompts'
    paths: ['/key']
    indexingPolicy: {
      includedPaths: [{ path: '/*' }]
      excludedPaths: [{ path: '/prompt/?' }, { path: '/"_etag"/?' }]
    }
  }
]

// The data-plane role ids are fixed: Cosmos DB Built-in Data Reader and Contributor.
var dataReader = '00000000-0000-0000-0000-000000000001'
var dataContributor = '00000000-0000-0000-0000-000000000002'
var accountId = resourceId('Microsoft.DocumentDB/databaseAccounts', name)

module account 'br/public:avm/res/document-db/database-account:0.21.1' = {
  name: 'cosmos-account'
  params: {
    name: name
    location: location
    tags: tags
    capacityMode: zoneRedundant ? 'Provisioned' : 'Serverless'
    zoneRedundant: zoneRedundant
    // Burst capacity is a provisioned account's; serverless refuses it.
    enableBurstCapacity: zoneRedundant
    disableLocalAuthentication: true
    disableKeyBasedMetadataWriteAccess: true
    // Point-in-time restore over seven days, the tier that costs nothing.
    backupPolicyContinuousTier: 'Continuous7Days'
    networkRestrictions: { publicNetworkAccess: publicAccess(private), ipRules: [], virtualNetworkRules: [] }
    sqlDatabases: [
      {
        name: appDatabase
        autoscaleSettingsMaxThroughput: zoneRedundant ? 1000 : null
        containers: containers
      }
    ]
    sqlRoleAssignments: concat(
      map(appContributors, principalId => {
        principalId: principalId
        roleDefinitionId: dataContributor
        scope: '${accountId}/dbs/${appDatabase}'
      }),
      map(readers, principalId => { principalId: principalId, roleDefinitionId: dataReader })
    )
    privateEndpoints: privateEndpoints
    lock: lock ? { kind: 'CanNotDelete' } : null
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

output name string = account.outputs.name
output endpoint string = account.outputs.endpoint
output database string = appDatabase
