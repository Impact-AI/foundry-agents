param name string
param location string
param tags object
param workspaceId string
@description('Room for Azure Bastion and the jump VM: the developer access switch.')
param developerAccess bool
@description('The Agent Service subnet\'s outbound path: open, the platform\'s default outbound access with no filter; restricted, a NAT gateway as the only way out and a network security group that admits only what the capability host and the agents are documented to need.')
@allowed(['open', 'restricted'])
param agentEgress string
@description('The Azure Monitor private DNS zones, for the private link scope telemetry is ingested through.')
param privateTelemetry bool
@description('The names of the network security groups, the NAT gateway and its public address.')
param names {
  dataSecurityGroup: string
  agentSecurityGroup: string
  bastionSecurityGroup: string
  jumpSecurityGroup: string
  natGateway: string
  natAddress: string
}

// Only the hardened bundle has a network: a workload-profiles environment
// needs a /27 or larger of its own, and the data subnet carries the private
// endpoints the apps reach every data service through. Each service's private
// DNS zone is linked to the network, so the apps resolve the private address
// and nothing else does.
//
// `agent` is the Foundry Agent Service's network injection: a /24 delegated
// to Container Apps environments and used by the one Foundry account alone,
// in the account's region. The agent runs there and reaches Cosmos DB,
// Storage and AI Search through the same private endpoints the apps use.
// Its outbound path is `agentEgress` (docs/decisions.md, "The agent subnet's
// egress"): open keeps the subnet's default outbound access, which the
// platform needs to finish creating the capability host when nothing else
// gives the subnet a way out; restricted turns that off, gives the subnet a
// NAT gateway instead, and filters it with a network security group.
//
// Network security groups follow the Foundry baseline reference
// architecture, subnet by subnet, except where the platform forbids one:
// `apps` carries none, because the environment's ingress is external and
// arrives through a public address in its managed resource group, not
// through the subnet, so an inbound rule there filters nothing, and its
// outbound is the apps' own (the public registry, Entra ID, the providers
// they call).
var restricted = agentEgress == 'restricted'

var prefixes = {
  apps: '10.0.0.0/23'
  data: '10.0.2.0/24'
  bastion: '10.0.3.0/26'
  jump: '10.0.3.64/27'
  agent: '10.0.4.0/24'
}

// One security rule. A single port, or `*`, is a range; more are a list.
func rule(name string, priority int, direction string, access string, protocol string, source string, destination string, ports string[]) object => {
  name: name
  properties: union(
    {
      priority: priority
      direction: direction
      access: access
      protocol: protocol
      sourceAddressPrefix: source
      sourcePortRange: '*'
      destinationAddressPrefix: destination
    },
    length(ports) == 1 ? { destinationPortRange: ports[0] } : { destinationPortRanges: ports }
  )
}

// Private endpoints answer; they never call out.
resource dataSecurityGroup 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: names.dataSecurityGroup
  location: location
  tags: tags
  properties: {
    securityRules: [
      rule('DenyAllOutBound', 1000, 'Outbound', 'Deny', '*', '*', '*', ['*'])
    ]
  }
}

// Restricted: in, nothing (as the baseline's agent subnet); out, the private
// endpoints, the subnet itself, and the service tags Learn names for a
// Container Apps workload-profiles subnet and for the Agent Service's
// injection — Microsoft Entra ID for the managed identities, Microsoft
// Artifact Registry and the Front Door it is served through for the
// platform's own containers, Azure Monitor — then nothing. Azure DNS
// (168.63.129.16) is not subject to a security group.
resource agentSecurityGroup 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (restricted) {
  name: names.agentSecurityGroup
  location: location
  tags: tags
  properties: {
    securityRules: [
      rule('DenyAllInBound', 1000, 'Inbound', 'Deny', '*', '*', '*', ['*'])
      rule('Agents.Out.Allow.PrivateEndpoints', 100, 'Outbound', 'Allow', '*', prefixes.agent, prefixes.data, ['*'])
      rule('Agents.Out.Allow.Subnet', 110, 'Outbound', 'Allow', '*', prefixes.agent, prefixes.agent, ['*'])
      rule('Agents.Out.Allow.AzureActiveDirectory', 120, 'Outbound', 'Allow', 'Tcp', prefixes.agent, 'AzureActiveDirectory', ['443'])
      rule('Agents.Out.Allow.MicrosoftContainerRegistry', 130, 'Outbound', 'Allow', 'Tcp', prefixes.agent, 'MicrosoftContainerRegistry', ['443'])
      rule('Agents.Out.Allow.AzureFrontDoor', 140, 'Outbound', 'Allow', 'Tcp', prefixes.agent, 'AzureFrontDoor.FirstParty', ['443'])
      rule('Agents.Out.Allow.AzureMonitor', 150, 'Outbound', 'Allow', 'Tcp', prefixes.agent, 'AzureMonitor', ['443'])
      rule('DenyAllOutBound', 1000, 'Outbound', 'Deny', '*', '*', '*', ['*'])
    ]
  }
}

// The restricted subnet's one way out, with a fixed public address.
resource natAddress 'Microsoft.Network/publicIPAddresses@2024-05-01' = if (restricted) {
  name: names.natAddress
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Regional' }
  properties: { publicIPAddressVersion: 'IPv4', publicIPAllocationMethod: 'Static' }
}

resource natGateway 'Microsoft.Network/natGateways@2024-05-01' = if (restricted) {
  name: names.natGateway
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: {
    idleTimeoutInMinutes: 4
    publicIpAddresses: [{ id: natAddress.id }]
  }
}

// Azure Bastion's documented rule set (learn.microsoft.com/azure/bastion/bastion-nsg),
// as the baseline carries it.
resource bastionSecurityGroup 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (developerAccess) {
  name: names.bastionSecurityGroup
  location: location
  tags: tags
  properties: {
    securityRules: [
      rule('Bastion.In.Allow.Https', 100, 'Inbound', 'Allow', 'Tcp', 'Internet', '*', ['443'])
      rule('Bastion.In.Allow.GatewayManager', 110, 'Inbound', 'Allow', 'Tcp', 'GatewayManager', '*', ['443', '4443'])
      rule('Bastion.In.Allow.LoadBalancer', 120, 'Inbound', 'Allow', 'Tcp', 'AzureLoadBalancer', '*', ['443'])
      rule('Bastion.In.Allow.BastionHostCommunication', 130, 'Inbound', 'Allow', '*', 'VirtualNetwork', 'VirtualNetwork', ['8080', '5701'])
      rule('DenyAllInBound', 1000, 'Inbound', 'Deny', '*', '*', '*', ['*'])
      rule('Bastion.Out.Allow.SshRdp', 100, 'Outbound', 'Allow', 'Tcp', '*', 'VirtualNetwork', ['22', '3389'])
      rule('Bastion.Out.Allow.AzureMonitor', 110, 'Outbound', 'Allow', '*', prefixes.bastion, 'AzureMonitor', ['*'])
      rule('Bastion.Out.Allow.AzureCloudCommunication', 120, 'Outbound', 'Allow', 'Tcp', '*', 'AzureCloud', ['443'])
      rule('Bastion.Out.Allow.BastionHostCommunication', 130, 'Outbound', 'Allow', '*', 'VirtualNetwork', 'VirtualNetwork', ['8080', '5701'])
      rule('Bastion.Out.Allow.GetSessionInformation', 140, 'Outbound', 'Allow', '*', '*', 'Internet', ['80', '443'])
      rule('DenyAllOutBound', 1000, 'Outbound', 'Deny', '*', '*', '*', ['*'])
    ]
  }
}

// The jump VM: SSH from Bastion alone; out, the private endpoints and the
// internet its packages and Entra's sign-in come from.
resource jumpSecurityGroup 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (developerAccess) {
  name: names.jumpSecurityGroup
  location: location
  tags: tags
  properties: {
    securityRules: [
      rule('JumpBox.In.Allow.Ssh', 100, 'Inbound', 'Allow', 'Tcp', prefixes.bastion, prefixes.jump, ['22'])
      rule('DenyAllInBound', 1000, 'Inbound', 'Deny', '*', '*', '*', ['*'])
      rule('JumpBox.Out.Allow.PrivateEndpoints', 100, 'Outbound', 'Allow', '*', prefixes.jump, prefixes.data, ['*'])
      rule('JumpBox.Out.Allow.Internet', 130, 'Outbound', 'Allow', '*', prefixes.jump, 'Internet', ['*'])
      rule('DenyAllOutBound', 1000, 'Outbound', 'Deny', '*', '*', '*', ['*'])
    ]
  }
}

module virtualNetwork 'br/public:avm/res/network/virtual-network:0.10.2' = {
  name: 'virtual-network'
  params: {
    name: name
    location: location
    tags: tags
    addressPrefixes: ['10.0.0.0/16']
    subnets: concat(
      [
        { name: 'apps', addressPrefix: prefixes.apps, delegation: 'Microsoft.App/environments' }
        {
          name: 'data'
          addressPrefix: prefixes.data
          networkSecurityGroupResourceId: dataSecurityGroup.id
          // The security group applies to the private endpoints' traffic.
          privateEndpointNetworkPolicies: 'Enabled'
        }
        union(
          {
            name: 'agent'
            addressPrefix: prefixes.agent
            delegation: 'Microsoft.App/environments'
            defaultOutboundAccess: !restricted
          },
          restricted ? { networkSecurityGroupResourceId: agentSecurityGroup.id, natGatewayResourceId: natGateway.id } : {}
        )
      ],
      developerAccess
        ? [
            {
              name: 'AzureBastionSubnet'
              addressPrefix: prefixes.bastion
              networkSecurityGroupResourceId: bastionSecurityGroup.id
            }
            // The VM's own outbound, for its packages and for Entra to
            // validate a sign-in.
            {
              name: 'jump'
              addressPrefix: prefixes.jump
              defaultOutboundAccess: true
              networkSecurityGroupResourceId: jumpSecurityGroup.id
            }
          ]
        : []
    )
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

// A subnet's id by its name, so adding one never renumbers the others.
func subnet(ids string[], name string) string => filter(ids, id => endsWith(id, '/subnets/${name}'))[0]

var subnetIds = virtualNetwork.outputs.subnetResourceIds

// In the order the output below reads them. The Foundry account answers on
// three host names (openai, services.ai, cognitiveservices), each its own zone.
var zoneNames = [
  'privatelink.redis.azure.net'
  'privatelink.vaultcore.azure.net'
  'privatelink.azconfig.io'
  'privatelink.search.windows.net'
  'privatelink.openai.azure.com'
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.services.ai.azure.com'
  'privatelink.cognitiveservices.azure.com'
  'privatelink.documents.azure.com'
]

module zones 'br/public:avm/res/network/private-dns-zone:0.8.1' = [
  for (zone, i) in zoneNames: {
    name: 'dns-zone-${i}'
    params: {
      name: zone
      location: 'global'
      tags: tags
      virtualNetworkLinks: [{ virtualNetworkResourceId: virtualNetwork.outputs.resourceId }]
    }
  }
]

// Azure Monitor's private link: the four zones its private endpoint registers
// in (monitor, the Log Analytics ingestion and operations hosts, the agent
// service), as Microsoft's private-network Agent Service sample makes them.
// Blob is left out, as there: it serves only the monitoring agents' solution
// packs, which nothing here installs.
var monitorZoneNames = privateTelemetry
  ? [
      'privatelink.monitor.azure.com'
      'privatelink.oms.opinsights.azure.com'
      'privatelink.ods.opinsights.azure.com'
      'privatelink.agentsvc.azure-automation.net'
    ]
  : []

module monitorZones 'br/public:avm/res/network/private-dns-zone:0.8.1' = [
  for (zone, i) in monitorZoneNames: {
    name: 'dns-zone-monitor-${i}'
    params: {
      name: zone
      location: 'global'
      tags: tags
      virtualNetworkLinks: [{ virtualNetworkResourceId: virtualNetwork.outputs.resourceId }]
    }
  }
]

output appsSubnetId string = subnet(subnetIds, 'apps')
output dataSubnetId string = subnet(subnetIds, 'data')
output agentSubnetId string = subnet(subnetIds, 'agent')
output jumpSubnetId string = developerAccess ? subnet(subnetIds, 'jump') : ''
output resourceId string = virtualNetwork.outputs.resourceId
output dnsZones object = {
  redis: zones[0].outputs.resourceId
  vault: zones[1].outputs.resourceId
  settings: zones[2].outputs.resourceId
  search: zones[3].outputs.resourceId
  openai: zones[4].outputs.resourceId
  storage: zones[5].outputs.resourceId
  aiServices: zones[6].outputs.resourceId
  cognitiveServices: zones[7].outputs.resourceId
  cosmos: zones[8].outputs.resourceId
}
output monitorDnsZones string[] = [for (zone, i) in monitorZoneNames: monitorZones[i].outputs.resourceId]
