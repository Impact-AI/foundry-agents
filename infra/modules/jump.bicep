import { PrincipalType } from '../types.bicep'

param bastionName string
param vmName string
param location string
param tags object
param workspaceId string
param virtualNetworkId string
param subnetId string
@description('The operator: the one principal the VM admits through Microsoft Entra ID.')
param principalId string
param principalType PrincipalType
@description('An SSH public key the VM requires to exist; its private half was never kept, because sign-in is Entra\'s.')
param sshPublicKey string
@description('The VM size; regional, never zone-pinned, so any zone with capacity can take it.')
param vmSize string

// Bastion Basic: the lowest SKU whose portal connection signs in with
// Microsoft Entra ID (the free Developer SKU offers keys and passwords only).
module bastion 'br/public:avm/res/network/bastion-host:0.8.2' = {
  name: 'bastion'
  params: {
    name: bastionName
    location: location
    tags: tags
    skuName: 'Basic'
    virtualNetworkResourceId: virtualNetworkId
    diagnosticSettings: [{ workspaceResourceId: workspaceId }]
  }
}

// What a person inspecting the data plane needs and nothing else: az and azd
// (so a script that refuses a closed listener can run from here), redis-cli,
// and the commands on the screen.
var welcome = '''
This VM is inside the deployment's virtual network: every private endpoint
resolves here. Mint tokens on your own machine (signed in with az) and paste
them here; each lasts about an hour.

Redis, if you were given a data access policy:
  your machine: az account get-access-token --resource https://redis.azure.com --query accessToken -o tsv
                azd env get-values | grep REDIS_
  here:         redis-cli --tls -h <REDIS_HOST> -p <REDIS_PORT> --user <your object id> --pass '<token>'
'''
var cloudInit = '''
#cloud-config
package_update: true
packages: [ca-certificates, curl, git, gnupg, redis-tools]
write_files:
  - path: /etc/motd
    encoding: b64
    content: {0}
runcmd:
  - curl -sL https://aka.ms/InstallAzureCLIDeb | bash
  - curl -fsSL https://aka.ms/install-azd.sh | bash
'''

module vm 'br/public:avm/res/compute/virtual-machine:0.22.3' = {
  name: 'jump-vm'
  params: {
    name: vmName
    location: location
    tags: tags
    osType: 'Linux'
    vmSize: vmSize
    availabilityZone: -1
    imageReference: {
      publisher: 'Canonical'
      offer: 'ubuntu-24_04-lts'
      sku: 'server'
      version: 'latest'
    }
    osDisk: { managedDisk: { storageAccountType: 'StandardSSD_LRS' }, diskSizeGB: 32, deleteOption: 'Delete' }
    adminUsername: 'azureuser'
    disablePasswordAuthentication: true
    publicKeys: [{ path: '/home/azureuser/.ssh/authorized_keys', keyData: sshPublicKey }]
    nicConfigurations: [
      {
        nicSuffix: '-nic'
        deleteOption: 'Delete'
        ipConfigurations: [{ name: 'ipconfig1', subnetResourceId: subnetId }]
      }
    ]
    // The Entra login extension (below) validates a sign-in as the VM's own identity.
    managedIdentities: { systemAssigned: true }
    // Azure refuses any change of customData on an existing VM: a change to what
    // it renders needs the VM deleted before the next provision recreates it.
    // So the text is the same for every environment and names no other
    // resource: the cache's host and port are the environment's to print.
    customData: format(cloudInit, base64(welcome))
    roleAssignments: [
      {
        principalId: principalId
        principalType: principalType
        roleDefinitionIdOrName: 'Virtual Machine Administrator Login'
      }
    ]
  }
}

// The Entra login extension, declared here rather than through the module's
// extensionAadJoinConfig: the module hard-codes the extension type as
// `AADSSHLoginforLinux` (lowercase f; avm/res/compute/virtual-machine 0.22.3,
// and main) and offers no override, while the published image is
// `AADSSHLoginForLinux`. The portal's Bastion "Microsoft Entra ID" check
// can fail on a VM whose extension carries the lowercase type, installed
// and healthy. The case is the likely cause rather than a documented one,
// and Azure keeps an extension's type string as first created, so the
// published spelling is declared from the first create.
resource jumpVm 'Microsoft.Compute/virtualMachines@2024-07-01' existing = {
  name: vmName
}

resource entraLogin 'Microsoft.Compute/virtualMachines/extensions@2024-07-01' = {
  parent: jumpVm
  name: 'AADSSHLoginForLinux'
  location: location
  tags: tags
  properties: {
    publisher: 'Microsoft.Azure.ActiveDirectory'
    type: 'AADSSHLoginForLinux'
    typeHandlerVersion: '1.0'
    autoUpgradeMinorVersion: true
  }
  dependsOn: [vm]
}

output bastionName string = bastion.outputs.name
output vmName string = vm.outputs.name
