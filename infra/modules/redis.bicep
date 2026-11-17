import { publicAccess } from '../types.bicep'

param name string
param location string
param tags object
param workspaceId string
@description('An Azure Managed Redis SKU name, such as Balanced_B0.')
param sku string
@description('Replicated across two nodes, spread over availability zones where the region has them. It can be switched on for an instance that runs without it and never off again.')
param highAvailability bool
param private bool
param privateEndpoints array
@description('The object ids that read and write. The first is the user the apps dial as.')
param dataContributors string[]

// Azure Managed Redis (Microsoft.Cache/redisEnterprise and its one database).
// Entra only, access keys off: a client dials as its object id with a token
// for https://redis.azure.com as the password, over TLS, on the database's
// port.
//
// NoCluster keeps every key on one shard, which is what the callers assume:
// the ledger's and the queues' scripts name keys of several people and one
// shared pool in a single call, and a sharded policy refuses a call whose keys
// fall in different slots. The policy holds up to 25 GB, far past what the
// claims, buckets and queues here hold, and is the one policy the service
// lets an instance leave without being made again.
//
// VolatileLRU evicts only keys carrying a TTL, so a queue or lock key without
// one is never a candidate — every cache and rate-limit key carries a TTL for
// that reason.
// The service has one access policy, `default`: every command on every key.
// An assignment's name is letters and digits only, so it is the object id
// without its hyphens; the module reads the name of every assignment it is
// handed, so each carries one.
var admitted = [
  for objectId in dataContributors: {
    name: replace(objectId, '-', '')
    userObjectId: objectId
    accessPolicyName: 'default'
  }
]

module cache 'br/public:avm/res/cache/redis-enterprise:0.5.1' = {
  name: 'redis-cache'
  params: {
    name: name
    location: location
    tags: tags
    skuName: sku
    highAvailability: highAvailability ? 'Enabled' : 'Disabled'
    minimumTlsVersion: '1.2'
    publicNetworkAccess: publicAccess(private)
    database: {
      accessKeysAuthentication: 'Disabled'
      clientProtocol: 'Encrypted'
      clusteringPolicy: 'NoCluster'
      evictionPolicy: 'VolatileLRU'
      port: 10000
      accessPolicyAssignments: admitted
      // The connection logs are the database's; the instance's own setting
      // below carries its metrics.
      diagnosticSettings: [{ workspaceResourceId: workspaceId }]
    }
    privateEndpoints: privateEndpoints
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

output hostName string = cache.outputs.hostName
output port int = cache.outputs.port
// The Entra form @platform/redis reads: the object id is the user, no
// password, and the token is minted per dial.
output url string = 'rediss://${dataContributors[0]}@${cache.outputs.hostName}:${cache.outputs.port}'
