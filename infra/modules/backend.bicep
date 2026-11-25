import { Identity, Models, Release } from '../types.bicep'

param name string
param migrateJobName string
param location string
param tags object
param environmentId string
param identity Identity
param migrateIdentity Identity
param image string
@description('Whether this container app exists already, which azd answers at each provision.')
param exists bool
param registryServer string
param minReplicas int
param maxReplicas int
param vaultUri string
param settingsEndpoint string
@description('The Cosmos DB account endpoint and the database on it that holds the accounts, the persona and the thread index.')
param cosmos { endpoint: string, database: string }
@description('The Foundry project the agent runs in and the guardrail its versions carry.')
param foundry { endpoint: string, raiPolicy: string }
@description('The container every library is uploaded to: the job describes and indexes it, the backend reads its pictures and its text documents.')
param libraryContainer string
@description('The container the deployment\'s logo is read from, apart from the library.')
param appearanceContainer string
@description('The storage account\'s resource id, which AI Search\'s data source connects to the library with, under the service\'s own identity.')
param storageResourceId string
@description('What the job runs and rests on: the deploy\'s steps, in order (src/job.ts).')
param jobSteps string[]
param redisUrl string
param modelsResourceName string
param models Models
param searchEndpoint string
param searchIndex string
param storageAccount string
param insightsConnectionString string
param hardened bool
@description('Whether the data services sit behind private endpoints with their public listeners off: the backend keeps memory in its own store then, since the Foundry memory store\'s extraction calls the account from outside the network.')
param privateNetworking bool
@description('Whether the knowledge base\'s planning deployment is made: the job then gives the base its model, so a search may run above minimal effort.')
param knowledgeBasePlanner bool
@description('The components the deploy chose, each the starting value of its settings field; empty is the shipped default.')
param components { memoryStore: string, historyStore: string, retrievalEngine: string, voiceEngine: string }
@description('The business system the records adapter reads and the scope its token is requested for; an empty URL reads the sample records.')
param records { url: string, scope: string }
@description('How people sign in: entra, the identity provider, or local, a named demo sign-in. Hardened forces entra.')
param authMode string
param authRequireRole bool
@description('The release the named image is, which every span the app exports carries. With no image named, the app keeps the release it runs, as it keeps its image.')
param release Release
@description('The suffix of the revision this provision makes when it names the image: the release names its revision. Ignored with no image named.')
param revisionSuffix string
@description('impact.ai\'s OTLP traces URL for the product, which the app copies every span to. Empty, the app keeps the one it runs.')
param impactEndpoint string
@description('Whether the vault holds impact.ai\'s ingest key, or this provision writes it: only then does the app reference it.')
param impactKeyHeld bool

var port = 4111
// Until azd has deployed, a public placeholder keeps the app provisionable;
// the migrate job carries the same image and is only ever started after a
// deploy. A provision that names no image (a machine whose azd environment
// holds none, as a pipeline's runner does) keeps the image the app runs:
// only an app that does not exist yet takes the placeholder.
var placeholder = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
resource running 'Microsoft.App/containerApps@2024-03-01' existing = if (exists) {
  name: name
}
var effectiveImage = !empty(image)
  ? image
  : exists ? running!.properties.template.containers[0].image : placeholder
// An app provisioned twice before its first deploy still runs the placeholder,
// which answers on neither probe's port.
var deployed = effectiveImage != placeholder
var imageTag = deployed ? last(split(effectiveImage, ':')) : ''
// What the running app's container is given, by name. A provision that names
// no image keeps the release it runs and the endpoint it copies to, as it
// keeps the image: `azd deploy` sets the release with each new image
// (azure.yaml), so a provision between two deploys never puts one version's
// release on another's image, and a pipeline's run, which carries neither,
// changes neither.
var held = toObject(exists ? running!.properties.template.containers[0].env : [], e => e.name, e => e.?value ?? '')
var stamp = !empty(image)
  ? release
  : {
      id: held.?IMPACT_RELEASE_ID ?? ''
      version: held.?IMPACT_RELEASE_VERSION ?? ''
      environment: held.?IMPACT_RELEASE_ENVIRONMENT ?? ''
    }
var copyTo = !empty(impactEndpoint) ? impactEndpoint : held.?IMPACT_ENDPOINT ?? ''
// The optional route's key: a vault reference where there is one, else
// empty, and the app copies nothing.
var ingestKey = impactKeyHeld
  ? { name: 'IMPACT_API_KEY', secretRef: 'impact-api-key' }
  : { name: 'IMPACT_API_KEY', value: '' }

func secrets(vault string, identityId string, ingestKey bool) array => concat(
  [{ name: 'auth-secret', keyVaultUrl: '${vault}secrets/auth-secret', identity: identityId }],
  ingestKey ? [{ name: 'impact-api-key', keyVaultUrl: '${vault}secrets/impact-api-key', identity: identityId }] : []
)

// Exactly apps/backend/.env.example, bootstrap only; empty means the
// compiled-in default. AZURE_CLIENT_ID is the SDK's own: it picks this
// identity out of the several a replica could hold.
var env = [
  { name: 'AZURE_CLIENT_ID', value: identity.clientId }
  { name: 'PORT', value: string(port) }
  { name: 'IMAGE_TAG', value: imageTag }
  { name: 'IMPACT_RELEASE_ID', value: stamp.id }
  { name: 'IMPACT_RELEASE_VERSION', value: stamp.version }
  { name: 'IMPACT_RELEASE_ENVIRONMENT', value: stamp.environment }
  { name: 'APP_CONFIG_ENDPOINT', value: settingsEndpoint }
  { name: 'APP_CONFIG_KEY_PREFIX', value: '' }
  { name: 'APP_CONFIG_TIMEOUT_MS', value: '' }
  { name: 'CONFIG_TTL_MS', value: '' }
  { name: 'AUTH_SECRET', secretRef: 'auth-secret' }
  { name: 'AUTH_MODE', value: authMode }
  { name: 'AUTH_REQUIRE_ROLE', value: authRequireRole ? '1' : '' }
  { name: 'HARDENED', value: string(hardened) }
  { name: 'PRIVATE_NETWORKING', value: string(privateNetworking) }
  { name: 'MEMORY_STORE', value: components.memoryStore }
  { name: 'HISTORY_STORE', value: components.historyStore }
  { name: 'RETRIEVAL_ENGINE', value: components.retrievalEngine }
  { name: 'VOICE_ENGINE', value: components.voiceEngine }
  { name: 'COSMOS_ENDPOINT', value: cosmos.endpoint }
  { name: 'COSMOS_DATABASE', value: cosmos.database }
  { name: 'REDIS_URL', value: redisUrl }
  { name: 'REDIS_COMMAND_TIMEOUT_MS', value: '' }
  { name: 'REDIS_CONNECT_TIMEOUT_MS', value: '' }
  { name: 'REDIS_RETRY_COOLDOWN_MS', value: '' }
  { name: 'FOUNDRY_PROJECT_ENDPOINT', value: foundry.endpoint }
  { name: 'FOUNDRY_RAI_POLICY', value: foundry.raiPolicy }
  { name: 'FOUNDRY_MEMORY_STORE', value: '' }
  { name: 'FOUNDRY_REQUEST_DEADLINE_MS', value: '' }
  { name: 'AZURE_OPENAI_RESOURCE_NAME', value: modelsResourceName }
  { name: 'AZURE_OPENAI_CHAT_DEPLOYMENT', value: models.chat.name }
  { name: 'AZURE_OPENAI_SMALL_CHAT_DEPLOYMENT', value: models.smallChat.name }
  { name: 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT', value: models.embedding.name }
  { name: 'AZURE_OPENAI_EMBEDDING_DIMENSIONS', value: '' }
  { name: 'AZURE_OPENAI_EMBEDDING_MODEL', value: models.embedding.model }
  { name: 'AZURE_OPENAI_REALTIME_DEPLOYMENT', value: models.?realtime.?name ?? '' }
  { name: 'AZURE_OPENAI_REALTIME_MODEL', value: models.?realtime.?model ?? '' }
  { name: 'AZURE_OPENAI_REALTIME_ALTERNATE_DEPLOYMENT', value: models.?realtimeAlternate.?name ?? '' }
  { name: 'AZURE_OPENAI_REALTIME_ALTERNATE_MODEL', value: models.?realtimeAlternate.?model ?? '' }
  { name: 'AZURE_OPENAI_KNOWLEDGE_BASE_DEPLOYMENT', value: knowledgeBasePlanner ? models.knowledgeBase!.name : '' }
  { name: 'AZURE_OPENAI_KNOWLEDGE_BASE_MODEL', value: knowledgeBasePlanner ? models.knowledgeBase!.model : '' }
  { name: 'AZURE_SEARCH_ENDPOINT', value: searchEndpoint }
  { name: 'AZURE_SEARCH_INDEX', value: searchIndex }
  { name: 'KNOWLEDGE_PLANNER_DEADLINE_MS', value: '' }
  { name: 'KNOWLEDGE_PLANNER_INFLIGHT', value: '' }
  { name: 'AZURE_STORAGE_ACCOUNT', value: storageAccount }
  { name: 'AZURE_STORAGE_ENDPOINT', value: '' }
  { name: 'AZURE_STORAGE_CONTAINER', value: libraryContainer }
  { name: 'AZURE_STORAGE_APPEARANCE_CONTAINER', value: appearanceContainer }
  { name: 'AZURE_STORAGE_RESOURCE_ID', value: '' }
  { name: 'RECORDS_API_URL', value: records.url }
  { name: 'RECORDS_API_SCOPE', value: records.scope }
  { name: 'MEMORY_CACHE_TTL_SECONDS', value: '' }
  { name: 'PERSON_CACHE_TTL_SECONDS', value: '' }
  { name: 'LAST_CONVERSATION_CACHE_TTL_SECONDS', value: '' }
  { name: 'THREAD_OWNER_CACHE_TTL_SECONDS', value: '' }
  { name: 'TURN_CLAIM_TTL_SECONDS', value: '' }
  { name: 'TURN_CLAIM_DEADLINE_MS', value: '' }
  { name: 'WARMUP_TTL_MS', value: '' }
  { name: 'TITLE_MAX_INFLIGHT', value: '' }
  { name: 'TITLE_DEADLINE_MS', value: '' }
  { name: 'METERING_SWEEP_INTERVAL_MS', value: '' }
  { name: 'METERING_UNAVAILABLE_LOG_SECONDS', value: '' }
  { name: 'SSE_HEARTBEAT_MS', value: '15000' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insightsConnectionString }
  { name: 'IMPACT_ENDPOINT', value: copyTo }
  ingestKey
  { name: 'PROBLEM_LOG', value: '' }
  { name: 'LLM_USAGE_LOG', value: '' }
]

// The job is the backend's environment under its own identity, which holds
// what the backend must not write. It makes AI Search's pipeline, whose data
// source names the storage account by its resource id. It runs without the
// cache: the URL dials as the backend's user, which its identity is not.
var jobOverrides = {
  AZURE_CLIENT_ID: migrateIdentity.clientId
  AZURE_STORAGE_RESOURCE_ID: storageResourceId
  REDIS_URL: ''
}
var jobEnv = map(env, e => contains(jobOverrides, e.name) ? { name: e.name, value: jobOverrides[e.name] } : e)

// The probes an app running a built image answers. One provisioned on the
// placeholder gets none, since the placeholder answers on neither port, and
// `azd deploy` changes only the image: postdeploy gives a deployed app that
// holds none these, from the outputs, so a first `azd up` ends probed.
var healthProbes = [
  {
    // Not ready until the host has started: the stores and the Foundry project answer.
    type: 'Readiness'
    httpGet: { path: '/ready', port: port, scheme: 'HTTP' }
    initialDelaySeconds: 5
    periodSeconds: 10
    timeoutSeconds: 3
    failureThreshold: 3
  }
  {
    type: 'Liveness'
    httpGet: { path: '/health', port: port, scheme: 'HTTP' }
    initialDelaySeconds: 20
    periodSeconds: 30
    timeoutSeconds: 5
    failureThreshold: 5
  }
]
var probes = deployed ? healthProbes : []

module app 'br/public:avm/res/app/container-app:0.23.0' = {
  name: 'backend-app'
  params: {
    name: name
    location: location
    tags: union(tags, { 'azd-service-name': 'backend' })
    environmentResourceId: environmentId
    managedIdentities: { userAssignedResourceIds: [identity.resourceId] }
    registries: [{ server: registryServer, identity: identity.resourceId }]
    secrets: secrets(vaultUri, identity.resourceId, impactKeyHeld)
    ingressExternal: false
    ingressTargetPort: port
    ingressTransport: 'auto'
    scaleSettings: {
      minReplicas: minReplicas
      maxReplicas: maxReplicas
      // Streams held per replica before another is asked for: a replica of
      // this shape saturates at about twenty, so it scales out before that.
      rules: [{ name: 'http-concurrency', http: { metadata: { concurrentRequests: '14' } } }]
    }
    // A replica going away tells the live sessions it holds to reopen, waits
    // the voice document's `live.drainGraceMs` (10 s), then settles each
    // within `live.settleWaitMs` (5 s): the grace covers both, with room.
    terminationGracePeriodSeconds: 30
    revisionSuffix: !empty(image) && !empty(revisionSuffix) ? revisionSuffix : null
    containers: [
      {
        name: 'backend'
        image: effectiveImage
        resources: { cpu: json('1.0'), memory: '2Gi' }
        env: env
        probes: probes
      }
    ]
  }
}

module migrate 'br/public:avm/res/app/job:0.7.2' = {
  name: 'migrate-job'
  params: {
    name: migrateJobName
    location: location
    tags: tags
    environmentResourceId: environmentId
    managedIdentities: { userAssignedResourceIds: [migrateIdentity.resourceId] }
    registries: [{ server: registryServer, identity: migrateIdentity.resourceId }]
    secrets: secrets(vaultUri, migrateIdentity.resourceId, impactKeyHeld)
    triggerType: 'Manual'
    manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
    replicaRetryLimit: 0
    replicaTimeout: 1800
    containers: [
      {
        name: 'migrate'
        image: effectiveImage
        // The steps are the arguments: the deploy's, which postdeploy runs and
        // a manual start repeats; the ingest script swaps in its own and back.
        command: ['bun', '--use-system-ca', 'run']
        args: concat(['src/job.ts'], jobSteps)
        // The job module types cpu as a string; the container-app module takes a number.
        resources: { cpu: '0.5', memory: '1Gi' }
        env: jobEnv
      }
    ]
  }
}

output fqdn string = app.outputs.fqdn
output name string = name
output probes array = healthProbes
