@export()
type ModelDeployment = {
  @description('The deployment name the apps address; AZURE_OPENAI_*_DEPLOYMENT.')
  name: string
  model: string
  version: string
  sku: string
  capacity: int
}

@export()
@description('A realtime model\'s deployment, without its capacity: that is set when the environment is deployed (`realtimeCapacity`, `realtimeAlternateCapacity`), since it is what a subscription\'s quota decides.')
type RealtimeDeployment = {
  @description('The deployment name the backend addresses; AZURE_OPENAI_REALTIME_*DEPLOYMENT.')
  name: string
  model: string
  version: string
  sku: string
}

@export()
@description('The knowledge base\'s planning model\'s deployment, without its capacity: that is set when the environment is deployed (`knowledgeBaseCapacity`). Made only with the `knowledgeBase` parameter on. The model must be one AI Search lists for a knowledge base.')
type KnowledgeBaseDeployment = {
  @description('The deployment name the job writes into the knowledge base; AZURE_OPENAI_KNOWLEDGE_BASE_DEPLOYMENT.')
  name: string
  model: string
  version: string
  sku: string
}

@export()
@description('One deployment per role the backend names. `realtime` is the Azure OpenAI realtime model the speech-to-speech voice agent runs on; left out, there is no voice deployment and the voice agent runs as a cascade on `chat`. `realtimeAlternate` is an optional second realtime model a voice tester may switch their own sessions to; left out, there is none to switch to.')
type Models = {
  chat: ModelDeployment
  smallChat: ModelDeployment
  embedding: ModelDeployment
  realtime: RealtimeDeployment?
  realtimeAlternate: RealtimeDeployment?
  knowledgeBase: KnowledgeBaseDeployment?
}

@export()
type Identity = {
  name: string
  resourceId: string
  principalId: string
  clientId: string
}

@export()
@description('A release, which every span of both apps carries: its id (`rel_` and 24 hex characters, the same in every environment), its version (the Development run that built it) and the environment it runs in (`development` or `production`). Each is empty outside a release.')
type Release = {
  id: string
  version: string
  environment: string
}

@export()
type PrincipalType = 'User' | 'ServicePrincipal' | 'Group'

@export()
type RoleAssignment = {
  principalId: string
  principalType: PrincipalType
  roleDefinitionIdOrName: string
}

@export()
@description('A switch that overrides one part of the `hardened` bundle: empty takes the bundle\'s answer, which is how an azd environment leaves it unset.')
type Override = '' | 'true' | 'false'

@export()
func resolve(override Override, bundle bool) bool => empty(override) ? bundle : override == 'true'

@export()
@description('The private endpoints the Azure Verified Modules take: one, in the data subnet, registered in its service\'s private DNS zones (one for most; the Foundry account answers on three host names).')
func privateEndpoint(subnetId string, dnsZoneIds string[]) array => [
  {
    subnetResourceId: subnetId
    privateDnsZoneGroup: { privateDnsZoneGroupConfigs: map(dnsZoneIds, zone => { privateDnsZoneResourceId: zone }) }
  }
]

@export()
type PublicAccess = 'Disabled' | 'Enabled'

@export()
func publicAccess(private bool) PublicAccess => private ? 'Disabled' : 'Enabled'
