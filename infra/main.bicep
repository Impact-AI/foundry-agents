targetScope = 'subscription'

// Long on purpose: one call per tier, and every identity's role list beside
// it, so what an identity may reach is read here. The one exception is the
// Foundry project's own identity, whose roles the Agent Service needs in a
// fixed order around its capability host: modules/agent-service.bicep.

@minLength(1)
@maxLength(64)
@description('The azd environment name; every resource name derives from it.')
param environmentName string

@minLength(1)
@description('The region every resource is created in.')
param location string

@description('The principal running the provision. It is also the operator, who gets the data-plane roles a person works with (the portal\'s settings documents, uploading a library, the jump VM), unless `operatorPrincipalId` names somebody else.')
param principalId string

import { Models, Override, PrincipalType, privateEndpoint, resolve } from './types.bicep'
param principalType PrincipalType = 'User'

@description('The operator, when it is not the principal that provisions: a person or a group who gets the operator\'s data-plane roles and the jump VM\'s sign-in while a pipeline\'s identity provisions and gets none of them. Empty: the provisioning principal is the operator.')
param operatorPrincipalId string = ''
@description('The operator\'s kind, read only with `operatorPrincipalId`.')
param operatorPrincipalType PrincipalType = 'User'
// Provisioning itself is the control plane's, which the deploying role
// covers; every assignment below that a person works with is the operator's.
var operator = {
  id: empty(operatorPrincipalId) ? principalId : operatorPrincipalId
  type: empty(operatorPrincipalId) ? principalType : operatorPrincipalType
}

@description('Every model deployment on the account, by role. Versions live in main.parameters.json, next to model-deprecations.json.')
param models Models

@minValue(1)
@description('The capacity of the realtime deployment (`models.realtime`), in the units its SKU counts. Set per environment, because what a subscription can grant is its quota\'s to decide; one is enough to try live voice.')
param realtimeCapacity int = 1

@minValue(1)
@description('The capacity of the second realtime deployment (`models.realtimeAlternate`), when the parameter file names one.')
param realtimeAlternateCapacity int = 1

@minValue(1)
@description('The capacity of the knowledge base\'s planning deployment (`models.knowledgeBase`), made only with `knowledgeBase` on. A planning call reads the question and the source\'s description, a few thousand tokens at most, so ten is room for a few searches a minute; raise it before letting real traffic plan.')
param knowledgeBaseCapacity int = 10

@description('One switch for the hardened bundle: a virtual network, private endpoints with private DNS and the public listeners off, Front Door Premium with a WAF and the origin sealed, locks, purge protection and zone redundancy where a service offers it. False is the demo: public endpoints, the Container Apps ingress as the edge, nothing locked, the smallest SKUs. Each switch below overrides one part of it.')
param hardened bool = false

@description('The virtual network, the private endpoints and the public listeners off on Redis, Key Vault, App Configuration, AI Search, the Foundry account, Cosmos DB and Storage, and the Agent Service injected into a subnet of its own. The registry stays public in both modes, because remote builds push images to it.')
param privateNetworking Override = ''

@description('Front Door in front of the frontend, with the origin reachable only over its private link. Off, the frontend is served from the Container Apps ingress directly; the two are never both open.')
param useFrontDoor Override = ''

@description('CanNotDelete on everything that holds data nobody can recreate. The predown hook lifts them.')
param lockDataResources Override = ''

@description('Key Vault purge protection keeps a deleted vault\'s name for its soft-delete retention (seven days, the service\'s minimum), which a demo torn down and rebuilt under one environment name cannot afford.')
param keyVaultPurgeProtection Override = ''

@description('Zone redundancy where the service offers it: the Container Apps environment, a replicated Azure Managed Redis, ZRS storage, and Cosmos DB provisioned and zone-redundant rather than serverless (decided when the account is created).')
param zoneRedundant Override = ''

@description('Opt-in, with private networking: Application Insights and its Log Analytics workspace refuse public ingestion and take telemetry through an Azure Monitor private link scope with a private endpoint in the network; query stays public. Off (empty or false), ingestion stays public on every deployment, because the private path has refused the apps\' own telemetry (docs/decisions.md, decision 29). Ignored without the network.')
param privateTelemetry Override = ''

@description('Opt-in: connect the Foundry project to Application Insights, which turns on the Agent Service\'s own traces of every agent in it. A trace holds what a turn was asked and what it answered, kept for the workspace\'s retention where no delete or erase of the app\'s reaches it, so it is off unless asked for.')
param agentTracing bool = false

@description('Built-in Azure Policy definitions assigned to the resource group in Audit: local authentication off on the Foundry account, Cosmos DB, AI Search and Storage in both modes, and their public network access off with private networking. Audit changes nothing; it reports. The deploying role already covers assigning them (Owner, or User Access Administrator beside Contributor).')
param policyAudit bool = true

@description('Azure Bastion (Basic) and a small Linux VM in the virtual network, signed in to with Microsoft Entra ID, for a person to inspect the private data services. Only with private networking; off by default.')
param developerAccess bool = false
@description('The SSH public key the jump VM requires; preprovision generates it and keeps no private half.')
param developerAccessSshKey string = ''
@description('The Agent Service subnet\'s outbound path, with private networking: open keeps the subnet\'s default outbound access, unfiltered; restricted closes it, gives the subnet a NAT gateway as its one way out and a network security group that admits only the private endpoints and the service tags the platform documents (Microsoft Entra ID, Microsoft Artifact Registry and its Front Door, Azure Monitor). Empty is open. Ignored without the network.')
@allowed(['', 'open', 'restricted'])
param agentEgress string = 'open'
@description('The jump VM\'s size. A region can run out of one size (AllocationFailed) while another of the same shape is free; this is the knob for that.')
param developerVmSize string = 'Standard_D2as_v5'

var private = resolve(privateNetworking, hardened)
var jumpHost = private && developerAccess
var telemetryPrivate = private && resolve(privateTelemetry, false)
var frontDoor = resolve(useFrontDoor, hardened)
var locked = resolve(lockDataResources, hardened)
var purgeProtected = resolve(keyVaultPurgeProtection, hardened)
var zonal = resolve(zoneRedundant, hardened)

@description('The public origin of the frontend (scheme and host), for a custom domain. Empty derives it: the Front Door endpoint when there is one, else the Container Apps ingress.')
param publicOrigin string = ''

@description('An Azure Managed Redis SKU name. Unset, Balanced_B0, the smallest. Zone redundant, it runs replicated across two nodes, which the service spreads over zones; otherwise one node with no SLA.')
param redisSku string = 'Balanced_B0'
@allowed(['basic', 'standard', 'standard2', 'standard3'])
param searchSku string = 'basic'
@minValue(1)
@maxValue(12)
@description('AI Search replicas, a floor: zone redundant, the service runs at least two, the number from which it spreads replicas over availability zones and the one its SLA asks for queries. Three is what the SLA asks for queries and indexing together, and the most the basic tier runs.')
param searchReplicas int = 1
@description('The region of AI Search alone, for a region with the models\' quota and no Search capacity. Empty is `location`.')
param searchLocation string = ''

@minValue(1)
@description('The backend\'s floor. Zone redundant, an app runs at least two replicas whatever this says: one replica is in one zone.')
param backendMinReplicas int = 1
param backendMaxReplicas int = 3
@minValue(1)
@description('The frontend\'s floor, raised to two when zone redundant as the backend\'s is.')
param frontendMinReplicas int = 1
param frontendMaxReplicas int = 3
// A zone-redundant environment spreads an app's replicas over zones; with one
// replica there is nothing to spread.
var zonalFloor = zonal ? 2 : 1
var replicas = {
  backend: { min: max(backendMinReplicas, zonalFloor), max: max(backendMaxReplicas, backendMinReplicas, zonalFloor) }
  frontend: { min: max(frontendMinReplicas, zonalFloor), max: max(frontendMaxReplicas, frontendMinReplicas, zonalFloor) }
  // The basic tier runs three replicas at most, a limit of the service's: a
  // number past it is refused here, before anything is made, where the
  // service would refuse it after the rest.
  search: searchSku == 'basic' && searchReplicas > 3
    ? fail('SEARCH_REPLICAS is ${searchReplicas} and the basic AI Search tier runs at most 3. Set SEARCH_REPLICAS to 3 or fewer, or searchSku to a standard tier.')
    : max(searchReplicas, zonalFloor)
}

@description('The image azd deployed last, which it keeps in the environment of the machine that deployed. Empty, the app keeps the image it runs, or a placeholder until `azd deploy` when it does not exist yet.')
param backendImage string = ''
param frontendImage string = ''
@description('Whether the backend\'s container app exists, which azd answers at each provision (`SERVICE_BACKEND_RESOURCE_EXISTS`): with no image named, an app that exists keeps the one it runs.')
param backendExists bool = false
@description('The same, for the frontend.')
param frontendExists bool = false
@description('The services whose container app the resource group already holds, comma-separated, which preprovision asks Azure Resource Manager for. An app named here exists whatever azd answered, so a lookup of azd\'s that failed never puts the placeholder over an image that runs.')
param servicesRunning string = ''
var running = split(servicesRunning, ',')

@description('The names of the Key Vault secrets the vault already holds, comma-separated, which preprovision asks Azure Resource Manager for. A secret whose value is empty here is written as a placeholder only while the vault does not hold it, so a provision never replaces a working secret with one.')
param vaultHolds string = ''

@description('The session secret both apps sign with. Empty where the environment carries none: preprovision makes one only while the vault holds none, and a provision with no value leaves the vault\'s as it is. The default is what lets azd pass an empty value on, where a parameter with none would be asked for.')
@secure()
param authSecret string = ''
param entraClientId string = ''
@secure()
param entraClientSecret string = ''
param entraIssuer string = '${az.environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'

@description('The one AI Search index; the code\'s own default, so the template and a bare checkout name the same index.')
param searchIndex string = 'chunks'

@description('Make the knowledge base\'s planning deployment (`models.knowledgeBase`), which a search above `minimal` reasoning effort needs (the `knowledge` document\'s `retrieval.reasoningEffort`). The base itself is the migrate job\'s, made beside the index while `retrieval.engine` is `knowledgeBase`, with or without it.')
param knowledgeBase bool = false
var planned = knowledgeBase && models.?knowledgeBase != null

// The components a deployer chooses (docs/deployment.md, "Choose components
// at deploy time"): each the starting value of its settings field, which the
// migrate job seeds into an absent document. Empty is the shipped default.
// Which go together is checked by preprovision and the job
// (apps/backend/src/components.ts), not here.
@description('Where what is remembered about a person is kept: foundry, the Agent Service\'s memory store (preview, public deployments only), or own. Empty: foundry, own with private networking.')
@allowed(['', 'foundry', 'own'])
param memoryStore string = ''
@description('Where a new thread\'s messages are kept: own or foundry (the Agent Service\'s conversations). Empty: own.')
@allowed(['', 'own', 'foundry'])
param historyStore string = ''
@description('What answers a search, typed or spoken: hybrid, or knowledgeBase. Empty: hybrid.')
@allowed(['', 'hybrid', 'knowledgeBase'])
param retrievalEngine string = ''
@description('What answers a live session: speechToSpeech or cascade. Empty: speechToSpeech.')
@allowed(['', 'speechToSpeech', 'cascade'])
param voiceEngine string = ''

@description('The business system the record tools and the stage\'s record routes read, its base URL (docs/worked-example.md). Empty: the sample records, in memory.')
param recordsApiUrl string = ''
@description('The `.default` scope of that system\'s app registration, which the backend\'s managed identity requests a token for on every call. Empty: no token is sent.')
param recordsApiScope string = ''

@description('Load the sample\'s document library (apps/backend/sample/library) from the migrate job on every deploy, mirrored: a document already loaded is skipped, one no longer in the directory is removed. False removes the sample, for a deployment that brings its own documents, which the ingest script loads through the same job.')
param seedSampleLibrary bool = true

@description('How people sign in, decided once for both apps: entra, the identity provider, or local, a demo sign-in with a name and no password in which every sign-in is a new person. Hardened deployments sign in through the provider only, whatever this says.')
@allowed(['local', 'entra'])
param authMode string = 'local'
@description('Refuse a sign-in whose token carries neither of the app roles user, premium. Hardened deployments always refuse one, whatever this says.')
param authRequireRole bool = false
var signInMode = hardened ? 'entra' : authMode
var roleRequired = hardened || authRequireRole

@description('The release the named images are, which every span of both apps carries (`impact.release.id`): a release workflow sets it, the same in Development and Production. A provision that names no image keeps the release each app runs, as it keeps the image; `azd deploy` sets it with each new image (azure.yaml).')
param releaseId string = ''
@description('The release\'s version, the Development run that built it (`impact.release.version`, and `service.version` while set).')
param releaseVersion string = ''
@description('The environment the release runs in, `development` or `production` (`deployment.environment.name`).')
param releaseEnvironment string = ''
var release = { id: releaseId, version: releaseVersion, environment: releaseEnvironment }
@description('The suffix of the revision a provision that names the images makes of each app (`v<version>`, and a run\'s own mark after it), so its spans and the release\'s confirmation name the same revision. Ignored by a provision that names no image; empty, Container Apps names the revision.')
param revisionSuffix string = ''

@description('The optional Impact SDK route: impact.ai\'s OTLP traces URL for the product, to which both apps then send every span and the SDK\'s capture of their model calls beside Azure Monitor. Empty, each app keeps the one it runs, so a pipeline\'s run, which never carries it, changes nothing; with none, the apps export to Azure Monitor alone, which impact.ai reads through the Azure connection.')
param impactEndpoint string = ''
@description('The optional route\'s ingest key, written to Key Vault as `impact-api-key` when given; both apps then hold a reference. Empty, the vault keeps one it holds (`KEY_VAULT_HOLDS`) and writes none: the default deployment has no such secret.')
@secure()
param impactApiKey string = ''
// Whether the apps hold a reference to the key: only where the vault holds one or this provision writes one.
var impactKeyHeld = !empty(impactApiKey) || contains(split(vaultHolds, ','), 'impact-api-key')

// The deployments as the account makes them: the realtime roles and the
// knowledge base's planner take the capacity this environment was given, and
// the planner is made only for a deployment with the knowledge base. Without
// it the role is taken out of the base rather than set to null: union merges
// deeply and a null does not replace the parameter file's object, which has
// no capacity for the account to read.
var deployedModels = union(
  planned ? models : toObject(filter(items(models), m => m.key != 'knowledgeBase'), m => m.key, m => m.value),
  models.?realtime == null ? {} : { realtime: union(models.realtime!, { capacity: realtimeCapacity }) },
  models.?realtimeAlternate == null
    ? {}
    : { realtimeAlternate: union(models.realtimeAlternate!, { capacity: realtimeAlternateCapacity }) },
  planned ? { knowledgeBase: union(models.knowledgeBase!, { capacity: knowledgeBaseCapacity }) } : {}
)

var abbreviations = loadJsonContent('./abbreviations.json')
var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))
var tags = { 'azd-env-name': environmentName }

var names = {
  resourceGroup: '${abbreviations.resourcesResourceGroups}${environmentName}'
  workspace: '${abbreviations.operationalInsightsWorkspaces}${resourceToken}'
  insights: '${abbreviations.insightsComponents}${resourceToken}'
  registry: '${abbreviations.containerRegistryRegistries}${resourceToken}'
  virtualNetwork: '${abbreviations.networkVirtualNetworks}${resourceToken}'
  environment: '${abbreviations.appManagedEnvironments}${resourceToken}'
  backend: '${abbreviations.appContainerApps}backend-${resourceToken}'
  frontend: '${abbreviations.appContainerApps}frontend-${resourceToken}'
  migrate: '${abbreviations.appJobs}migrate-${resourceToken}'
  backendIdentity: '${abbreviations.managedIdentityUserAssignedIdentities}backend-${resourceToken}'
  frontendIdentity: '${abbreviations.managedIdentityUserAssignedIdentities}frontend-${resourceToken}'
  migrateIdentity: '${abbreviations.managedIdentityUserAssignedIdentities}migrate-${resourceToken}'
  redis: '${abbreviations.cacheRedis}${resourceToken}'
  search: '${abbreviations.searchSearchServices}${resourceToken}'
  // The Foundry account keeps the name it had as an Azure OpenAI account: it is upgraded in place.
  models: '${abbreviations.cognitiveServicesAccounts}${resourceToken}'
  cosmos: '${abbreviations.documentDBDatabaseAccounts}${resourceToken}'
  settings: '${abbreviations.appConfigurationConfigurationStores}${resourceToken}'
  vault: '${abbreviations.keyVaultVaults}${resourceToken}'
  storage: '${abbreviations.storageStorageAccounts}${resourceToken}'
  frontDoor: '${abbreviations.cdnProfiles}${resourceToken}'
  waf: '${abbreviations.networkFrontDoorWafPolicies}${resourceToken}'
  bastion: '${abbreviations.networkBastionHosts}${resourceToken}'
  jumpHost: '${abbreviations.computeVirtualMachines}jump-${resourceToken}'
  dataSecurityGroup: '${abbreviations.networkNetworkSecurityGroups}data-${resourceToken}'
  agentSecurityGroup: '${abbreviations.networkNetworkSecurityGroups}agent-${resourceToken}'
  bastionSecurityGroup: '${abbreviations.networkNetworkSecurityGroups}bastion-${resourceToken}'
  jumpSecurityGroup: '${abbreviations.networkNetworkSecurityGroups}jump-${resourceToken}'
  natGateway: '${abbreviations.networkNatGateways}agent-${resourceToken}'
  natAddress: '${abbreviations.networkPublicIPAddresses}agent-${resourceToken}'
  monitorLinkScope: '${abbreviations.insightsPrivateLinkScopes}${resourceToken}'
}

func assignment(principalId string, principalType PrincipalType, role string) object => {
  principalId: principalId
  principalType: principalType
  roleDefinitionIdOrName: role
}

// Foundry User (formerly Azure AI User), a built-in role the account module does not name.
var foundryUser = '53ca6127-db72-4b80-b1b0-d745d6d5456d'

// Named per environment: this deployment sits at subscription scope, where a
// second environment's provision running at once would otherwise collide.
module resourceGroup 'br/public:avm/res/resources/resource-group:0.4.4' = {
  name: 'resource-group-${resourceToken}'
  params: { name: names.resourceGroup, location: location, tags: tags }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  scope: az.resourceGroup(names.resourceGroup)
  dependsOn: [resourceGroup]
  params: {
    workspaceName: names.workspace
    insightsName: names.insights
    location: location
    tags: tags
    privateIngestion: telemetryPrivate
  }
}

module network 'modules/network.bicep' = if (private) {
  name: 'network'
  scope: az.resourceGroup(names.resourceGroup)
  dependsOn: [resourceGroup]
  params: {
    name: names.virtualNetwork
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    developerAccess: jumpHost
    agentEgress: agentEgress == 'restricted' ? 'restricted' : 'open'
    privateTelemetry: telemetryPrivate
    names: {
      dataSecurityGroup: names.dataSecurityGroup
      agentSecurityGroup: names.agentSecurityGroup
      bastionSecurityGroup: names.bastionSecurityGroup
      jumpSecurityGroup: names.jumpSecurityGroup
      natGateway: names.natGateway
      natAddress: names.natAddress
    }
  }
}

module telemetryLink 'modules/telemetry-link.bicep' = if (telemetryPrivate) {
  name: 'telemetry-link'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.monitorLinkScope
    location: location
    tags: tags
    insightsId: monitoring.outputs.insightsId
    workspaceId: monitoring.outputs.workspaceId
    subnetId: network!.outputs.dataSubnetId
    dnsZoneIds: network!.outputs.monitorDnsZones
  }
}

// One private endpoint per data service when the network exists, none otherwise.
var endpoints = private
  ? {
      redis: privateEndpoint(network!.outputs.dataSubnetId, [network!.outputs.dnsZones.redis])
      vault: privateEndpoint(network!.outputs.dataSubnetId, [network!.outputs.dnsZones.vault])
      settings: privateEndpoint(network!.outputs.dataSubnetId, [network!.outputs.dnsZones.settings])
      search: privateEndpoint(network!.outputs.dataSubnetId, [network!.outputs.dnsZones.search])
      // The Foundry account answers on three host names, one zone each.
      models: privateEndpoint(network!.outputs.dataSubnetId, [
        network!.outputs.dnsZones.openai
        network!.outputs.dnsZones.aiServices
        network!.outputs.dnsZones.cognitiveServices
      ])
      // A storage account has an endpoint per service; only blob is read.
      storage: map(privateEndpoint(network!.outputs.dataSubnetId, [network!.outputs.dnsZones.storage]), e => union(e, { service: 'blob' }))
      cosmos: map(privateEndpoint(network!.outputs.dataSubnetId, [network!.outputs.dnsZones.cosmos]), e => union(e, { service: 'Sql' }))
    }
  : { redis: [], vault: [], settings: [], search: [], models: [], storage: [], cosmos: [] }

module policies 'modules/policies.bicep' = if (policyAudit) {
  name: 'policies'
  scope: az.resourceGroup(names.resourceGroup)
  dependsOn: [resourceGroup]
  params: { displayPrefix: environmentName, private: private }
}

module identities 'modules/identities.bicep' = {
  name: 'identities'
  scope: az.resourceGroup(names.resourceGroup)
  dependsOn: [resourceGroup]
  params: {
    backendName: names.backendIdentity
    frontendName: names.frontendIdentity
    migrateName: names.migrateIdentity
    location: location
    tags: tags
  }
}

var backend = identities.outputs.backend
var frontend = identities.outputs.frontend
var migrate = identities.outputs.migrate

module registry 'modules/registry.bicep' = {
  name: 'registry'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.registry
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    roleAssignments: [
      assignment(backend.principalId, 'ServicePrincipal', 'AcrPull')
      assignment(frontend.principalId, 'ServicePrincipal', 'AcrPull')
      assignment(migrate.principalId, 'ServicePrincipal', 'AcrPull')
    ]
  }
}

module vault 'modules/vault.bicep' = {
  name: 'vault'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.vault
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    lock: locked
    purgeProtection: purgeProtected
    private: private
    privateEndpoints: endpoints.vault
    authSecret: authSecret
    entraClientId: entraClientId
    entraClientSecret: entraClientSecret
    entraIssuer: entraIssuer
    impactApiKey: impactApiKey
    held: filter(split(vaultHolds, ','), name => !empty(name))
    roleAssignments: [
      assignment(backend.principalId, 'ServicePrincipal', 'Key Vault Secrets User')
      assignment(frontend.principalId, 'ServicePrincipal', 'Key Vault Secrets User')
      assignment(migrate.principalId, 'ServicePrincipal', 'Key Vault Secrets User')
      assignment(operator.id, operator.type, 'Key Vault Secrets Officer')
    ]
  }
}

module settings 'modules/settings.bicep' = {
  name: 'settings'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.settings
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    lock: locked
    private: private
    privateEndpoints: endpoints.settings
    roleAssignments: [
      assignment(backend.principalId, 'ServicePrincipal', 'App Configuration Data Reader')
      // The job seeds the settings documents from inside the network; the
      // operator edits them in the portal.
      assignment(migrate.principalId, 'ServicePrincipal', 'App Configuration Data Owner')
      assignment(operator.id, operator.type, 'App Configuration Data Owner')
    ]
  }
}

module redis 'modules/redis.bicep' = {
  name: 'redis'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.redis
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    sku: redisSku
    highAvailability: zonal
    private: private
    privateEndpoints: endpoints.redis
    // The backend first: its object id is the user the apps' URL dials as.
    // The operator dials from the jump host as its own object id, which a
    // group cannot do: the service signs in a user, a service principal or a
    // managed identity, never a group's members through the group.
    dataContributors: concat([backend.principalId], jumpHost && operator.type != 'Group' ? [operator.id] : [])
  }
}

// The migrate job loads every library, the sample's on a deploy and an
// uploaded one from the ingest script: it writes each file's description
// into its blob's metadata (and the sample's files themselves). The backend
// reads the library's pictures and text documents, and the deployment's
// logo, and writes nothing.
module storage 'modules/storage.bicep' = {
  name: 'storage'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.storage
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    lock: locked
    zoneRedundant: zonal
    private: private
    privateEndpoints: endpoints.storage
    roleAssignments: [
      assignment(backend.principalId, 'ServicePrincipal', 'Storage Blob Data Reader')
      assignment(migrate.principalId, 'ServicePrincipal', 'Storage Blob Data Contributor')
      assignment(operator.id, operator.type, 'Storage Blob Data Contributor')
      // AI Search's indexer reads the library with its own identity.
      assignment(search.outputs.principalId, 'ServicePrincipal', 'Storage Blob Data Reader')
    ]
  }
}

module search 'modules/search.bicep' = {
  name: 'search'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.search
    location: empty(searchLocation) ? location : searchLocation
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    lock: locked
    sku: searchSku
    replicas: replicas.search
    private: private
    privateEndpoints: endpoints.search
    // Making the index, the data source, the skillset and the indexer is
    // Search Service Contributor, which also reaches the service's own
    // settings, so only the migrate job's identity holds it: the pipeline is
    // schema, made with the rest of it; the job also deletes a removed file's
    // chunks and writes what Prompt Shields said. The backend only queries.
    roleAssignments: [
      assignment(backend.principalId, 'ServicePrincipal', 'Search Index Data Reader')
      assignment(migrate.principalId, 'ServicePrincipal', 'Search Service Contributor')
      assignment(migrate.principalId, 'ServicePrincipal', 'Search Index Data Contributor')
      assignment(operator.id, operator.type, 'Search Index Data Contributor')
      assignment(operator.id, operator.type, 'Search Service Contributor')
    ]
  }
}

module modelAccount 'modules/models.bicep' = {
  name: 'models'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.models
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    models: deployedModels
    private: private
    privateEndpoints: endpoints.models
    agentSubnetId: private ? network!.outputs.agentSubnetId : ''
    // Cognitive Services User is the account's whole data plane (Prompt
    // Shields among it): the job's, to scan documents as they load, and
    // AI Search's own, for its indexer's OCR and embeddings, its vectorizer
    // and a knowledge base's planning model. The backend's: a live session on
    // the Voice Live API itself (`voice.runtime` `voiceLive`), which Learn's
    // Voice Live how-to names this role for, on the account's own host.
    roleAssignments: [
      assignment(backend.principalId, 'ServicePrincipal', 'Cognitive Services OpenAI User')
      assignment(backend.principalId, 'ServicePrincipal', 'Cognitive Services User')
      assignment(migrate.principalId, 'ServicePrincipal', 'Cognitive Services OpenAI User')
      assignment(migrate.principalId, 'ServicePrincipal', 'Cognitive Services User')
      assignment(search.outputs.principalId, 'ServicePrincipal', 'Cognitive Services User')
      assignment(operator.id, operator.type, 'Cognitive Services OpenAI User')
    ]
  }
}

// Serverless, or provisioned and zone-redundant with the bundle's zones. The
// operator writes the app's database too: publishing the persona
// (`bun run persona`) is an operator's write.
module cosmos 'modules/cosmos.bicep' = {
  name: 'cosmos'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.cosmos
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    lock: locked
    zoneRedundant: zonal
    private: private
    privateEndpoints: endpoints.cosmos
    appContributors: [backend.principalId, migrate.principalId, operator.id]
    readers: [operator.id]
  }
}

// The Foundry project on the account, its connections, and who may use it:
// the backend and the job (agent versions, skills, the memory store) and the
// operator, to see them in the portal.
module foundry 'modules/foundry.bicep' = {
  name: 'foundry'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    accountName: modelAccount.outputs.name
    location: location
    tags: tags
    cosmosName: cosmos.outputs.name
    storageName: storage.outputs.name
    searchName: search.outputs.name
    insightsName: monitoring.outputs.insightsName
    agentTracing: agentTracing
    projectUsers: [
      assignment(backend.principalId, 'ServicePrincipal', foundryUser)
      assignment(migrate.principalId, 'ServicePrincipal', foundryUser)
      assignment(operator.id, operator.type, foundryUser)
    ]
  }
}

module agentService 'modules/agent-service.bicep' = {
  name: 'agent-service'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    accountName: modelAccount.outputs.name
    projectName: foundry.outputs.name
    projectPrincipalId: foundry.outputs.principalId
    projectWorkspaceId: foundry.outputs.workspaceId
    connections: foundry.outputs.connections
    cosmosName: cosmos.outputs.name
    storageName: storage.outputs.name
    searchName: search.outputs.name
    injected: private
  }
}

module environment 'modules/environment.bicep' = {
  name: 'environment'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.environment
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    appsSubnetId: private ? network!.outputs.appsSubnetId : null
    zoneRedundant: zonal
    privateLinkOnly: frontDoor
  }
}

// The frontend's host is known before the app exists, which is what lets the
// edge be provisioned first, and the apps learn the edge's id and endpoint.
var frontendHost = '${names.frontend}.${environment.outputs.defaultDomain}'
var frontendOrigin = !empty(publicOrigin)
  ? publicOrigin
  : frontDoor ? 'https://${edge!.outputs.endpointHost}' : 'https://${frontendHost}'

module backendApp 'modules/backend.bicep' = {
  name: 'backend'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.backend
    migrateJobName: names.migrate
    location: location
    tags: tags
    environmentId: environment.outputs.resourceId
    identity: backend
    migrateIdentity: migrate
    image: backendImage
    exists: backendExists || contains(running, 'backend')
    registryServer: registry.outputs.loginServer
    minReplicas: replicas.backend.min
    maxReplicas: replicas.backend.max
    vaultUri: vault.outputs.uri
    settingsEndpoint: settings.outputs.endpoint
    cosmos: { endpoint: cosmos.outputs.endpoint, database: cosmos.outputs.database }
    foundry: {
      endpoint: foundry.outputs.endpoint
      raiPolicy: modelAccount.outputs.guardrail
    }
    libraryContainer: storage.outputs.libraryContainer
    appearanceContainer: storage.outputs.appearanceContainer
    storageResourceId: storage.outputs.resourceId
    jobSteps: ['settings', 'index', 'skills', 'agent', seedSampleLibrary ? 'library' : 'remove-library']
    redisUrl: redis.outputs.url
    modelsResourceName: modelAccount.outputs.name
    models: models
    searchEndpoint: search.outputs.endpoint
    searchIndex: searchIndex
    storageAccount: storage.outputs.name
    insightsConnectionString: monitoring.outputs.insightsConnectionString
    hardened: hardened
    privateNetworking: private
    knowledgeBasePlanner: planned
    components: {
      memoryStore: memoryStore
      historyStore: historyStore
      retrievalEngine: retrievalEngine
      voiceEngine: voiceEngine
    }
    records: { url: recordsApiUrl, scope: recordsApiScope }
    authMode: signInMode
    authRequireRole: roleRequired
    release: release
    revisionSuffix: revisionSuffix
    impactEndpoint: impactEndpoint
    impactKeyHeld: impactKeyHeld
  }
}

module frontendApp 'modules/frontend.bicep' = {
  name: 'frontend'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.frontend
    location: location
    tags: tags
    environmentId: environment.outputs.resourceId
    identity: frontend
    image: frontendImage
    exists: frontendExists || contains(running, 'frontend')
    registryServer: registry.outputs.loginServer
    minReplicas: replicas.frontend.min
    maxReplicas: replicas.frontend.max
    vaultUri: vault.outputs.uri
    backendUrl: 'https://${backendApp.outputs.fqdn}'
    publicOrigin: frontendOrigin
    insightsConnectionString: monitoring.outputs.insightsConnectionString
    hardened: hardened
    authMode: signInMode
    authRequireRole: roleRequired
    release: release
    revisionSuffix: revisionSuffix
    impactEndpoint: impactEndpoint
    impactKeyHeld: impactKeyHeld
  }
}

module edge 'modules/edge.bicep' = if (frontDoor) {
  name: 'edge'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    name: names.frontDoor
    wafName: names.waf
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    environmentId: environment.outputs.resourceId
    originHost: frontendHost
  }
}

module jump 'modules/jump.bicep' = if (jumpHost) {
  name: 'jump'
  scope: az.resourceGroup(names.resourceGroup)
  params: {
    bastionName: names.bastion
    vmName: names.jumpHost
    location: location
    tags: tags
    workspaceId: monitoring.outputs.workspaceId
    virtualNetworkId: network!.outputs.resourceId
    subnetId: network!.outputs.jumpSubnetId
    principalId: operator.id
    principalType: operator.type
    sshPublicKey: developerAccessSshKey
    vmSize: developerVmSize
  }
}

output AZURE_RESOURCE_GROUP string = names.resourceGroup
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.outputs.loginServer
output AZURE_CONTAINER_APPS_ENVIRONMENT_NAME string = environment.outputs.name
output HARDENED bool = hardened
output PRIVATE_NETWORKING bool = private
output AUTH_MODE string = signInMode
output BACKEND_URL string = 'https://${backendApp.outputs.fqdn}'
// What postdeploy gives an app azd deployed that holds no probes, as JSON.
output BACKEND_APP_NAME string = backendApp.outputs.name
output BACKEND_PROBES string = string(backendApp.outputs.probes)
output FRONTEND_APP_NAME string = frontendApp.outputs.name
output FRONTEND_PROBES string = string(frontendApp.outputs.probes)
// Not PUBLIC_ORIGIN: azd writes every output back into the environment, where
// it would come back as the override on the next provision.
output FRONTEND_URL string = frontendOrigin
output FRONT_DOOR_ENDPOINT string = frontDoor ? edge!.outputs.endpointHost : ''
output FRONT_DOOR_PROFILE_NAME string = frontDoor ? names.frontDoor : ''
output APP_CONFIG_ENDPOINT string = settings.outputs.endpoint
output KEY_VAULT_URI string = vault.outputs.uri
output AZURE_KEY_VAULT_NAME string = vault.outputs.name
output AZURE_OPENAI_RESOURCE_NAME string = modelAccount.outputs.name
output AZURE_OPENAI_ENDPOINT string = modelAccount.outputs.endpoint
output AZURE_SEARCH_ENDPOINT string = search.outputs.endpoint
output AZURE_SEARCH_INDEX string = searchIndex
output AZURE_STORAGE_ACCOUNT string = storage.outputs.name
output AZURE_STORAGE_LIBRARY_CONTAINER string = storage.outputs.libraryContainer
output REDIS_HOST string = redis.outputs.hostName
output REDIS_PORT int = redis.outputs.port
output MIGRATE_JOB_NAME string = names.migrate
output SEED_SAMPLE_LIBRARY bool = seedSampleLibrary
output BASTION_NAME string = jumpHost ? jump!.outputs.bastionName : ''
output JUMP_HOST_NAME string = jumpHost ? jump!.outputs.vmName : ''
output APPLICATIONINSIGHTS_CONNECTION_STRING string = monitoring.outputs.insightsConnectionString
output FOUNDRY_PROJECT_ENDPOINT string = foundry.outputs.endpoint
output FOUNDRY_RAI_POLICY string = modelAccount.outputs.guardrail
output COSMOS_ENDPOINT string = cosmos.outputs.endpoint
