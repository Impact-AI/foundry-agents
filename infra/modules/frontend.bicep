import { Identity, Release } from '../types.bicep'

param name string
param location string
param tags object
param environmentId string
param identity Identity
param image string
@description('Whether this container app exists already, which azd answers at each provision.')
param exists bool
param registryServer string
param minReplicas int
param maxReplicas int
param vaultUri string
param backendUrl string
param publicOrigin string
param insightsConnectionString string
param hardened bool
param authMode string
param authRequireRole bool
@description('The release the named image is, which every span the app exports carries. With no image named, the app keeps the release it runs, as it keeps its image.')
param release Release
@description('The suffix of the revision this provision makes when it names the image: the release names its revision. Ignored with no image named.')
param revisionSuffix string
@description('impact.ai\'s OTLP traces URL for the product, which the app copies every span to. Empty, the app keeps the one it runs.')
param impactEndpoint string

var port = 3000
// With no image named, an app that exists keeps the one it runs; one that
// does not takes a public placeholder until `azd deploy` (modules/backend.bicep).
var placeholder = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
resource running 'Microsoft.App/containerApps@2024-03-01' existing = if (exists) {
  name: name
}
var effectiveImage = !empty(image)
  ? image
  : exists ? running!.properties.template.containers[0].image : placeholder
var deployed = effectiveImage != placeholder
var imageTag = deployed ? last(split(effectiveImage, ':')) : ''
// With no image named, the app keeps the release it runs and the endpoint it
// copies to (modules/backend.bicep says why).
var held = toObject(exists ? running!.properties.template.containers[0].env : [], e => e.name, e => e.?value ?? '')
var stamp = !empty(image)
  ? release
  : {
      id: held.?IMPACT_RELEASE_ID ?? ''
      version: held.?IMPACT_RELEASE_VERSION ?? ''
      environment: held.?IMPACT_RELEASE_ENVIRONMENT ?? ''
    }
var copyTo = !empty(impactEndpoint) ? impactEndpoint : held.?IMPACT_ENDPOINT ?? ''

func vaultSecret(vault string, identityId string, name string) object => {
  name: name
  keyVaultUrl: '${vault}secrets/${name}'
  identity: identityId
}

// Exactly apps/frontend/.env.example, bootstrap only; the agent's id and
// every byte bound are the backend's answers. AUTH_URL is Auth.js's own
// variable: the origin it writes into the sign-in redirect, which behind an
// edge is not the host the replica sees.
var env = [
  { name: 'IMAGE_TAG', value: imageTag }
  { name: 'IMPACT_RELEASE_ID', value: stamp.id }
  { name: 'IMPACT_RELEASE_VERSION', value: stamp.version }
  { name: 'IMPACT_RELEASE_ENVIRONMENT', value: stamp.environment }
  { name: 'AUTH_URL', value: publicOrigin }
  { name: 'BACKEND_URL', value: backendUrl }
  { name: 'AUTH_SECRET', secretRef: 'auth-secret' }
  { name: 'AUTH_MODE', value: authMode }
  { name: 'AUTH_MICROSOFT_ENTRA_ID_ID', secretRef: 'entra-client-id' }
  { name: 'AUTH_MICROSOFT_ENTRA_ID_SECRET', secretRef: 'entra-client-secret' }
  { name: 'AUTH_MICROSOFT_ENTRA_ID_ISSUER', secretRef: 'entra-issuer' }
  { name: 'AUTH_REQUIRE_ROLE', value: authRequireRole ? '1' : '' }
  { name: 'HARDENED', value: string(hardened) }
  { name: 'SSE_HEARTBEAT_MS', value: '15000' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insightsConnectionString }
  { name: 'IMPACT_ENDPOINT', value: copyTo }
  { name: 'IMPACT_API_KEY', secretRef: 'impact-api-key' }
]

// The probes an app running a built image answers; on the placeholder, none
// until postdeploy gives them (modules/backend.bicep says why).
var healthProbes = [
  {
    type: 'Readiness'
    httpGet: { path: '/health', port: port, scheme: 'HTTP' }
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
  name: 'frontend-app'
  params: {
    name: name
    location: location
    tags: union(tags, { 'azd-service-name': 'frontend' })
    environmentResourceId: environmentId
    managedIdentities: { userAssignedResourceIds: [identity.resourceId] }
    registries: [{ server: registryServer, identity: identity.resourceId }]
    secrets: [
      vaultSecret(vaultUri, identity.resourceId, 'auth-secret')
      vaultSecret(vaultUri, identity.resourceId, 'entra-client-id')
      vaultSecret(vaultUri, identity.resourceId, 'entra-client-secret')
      vaultSecret(vaultUri, identity.resourceId, 'entra-issuer')
      vaultSecret(vaultUri, identity.resourceId, 'impact-api-key')
    ]
    ingressExternal: true
    ingressTargetPort: port
    ingressTransport: 'auto'
    scaleSettings: {
      minReplicas: minReplicas
      maxReplicas: maxReplicas
      rules: [{ name: 'http-concurrency', http: { metadata: { concurrentRequests: '14' } } }]
    }
    // A replica going away closes each relayed live socket as going away and
    // gives the streams it holds 25 s before it exits: the grace covers that.
    terminationGracePeriodSeconds: 30
    revisionSuffix: !empty(image) && !empty(revisionSuffix) ? revisionSuffix : null
    containers: [
      {
        name: 'frontend'
        image: effectiveImage
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: env
        probes: probes
      }
    ]
  }
}

output fqdn string = app.outputs.fqdn
output name string = name
output probes array = healthProbes
