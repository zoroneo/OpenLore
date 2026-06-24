// Sample Bicep deployment exercising the extractor's edge cases.
@description('Primary location for all resources')
param location string = resourceGroup().location
param storageName string

var prefix = 'app'
var fullName = '${prefix}${storageName}'

resource stg 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: fullName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'

  // Nested child resource — implicit parent edge to `stg`.
  resource blob 'blobServices' = {
    name: 'default'
  }
}

// `existing` reference to a pre-deployed resource → kind `data`.
resource existingKv 'Microsoft.KeyVault/vaults@2023-01-01' existing = {
  name: 'shared-kv'
}

resource app 'Microsoft.Web/sites@2022-09-01' = {
  name: '${prefix}-app'
  location: location
  dependsOn: [
    stg
  ]
  properties: {
    kvUri: existingKv.properties.vaultUri
    storageId: stg.id
  }
}

// Loop → a single node (matching Terraform count/for_each).
resource farm 'Microsoft.Web/serverfarms@2022-09-01' = [for i in range(0, 3): {
  name: 'plan-${i}'
  location: location
}]

// Local module → cross-file link to the resources in network.bicep.
module network './modules/network.bicep' = {
  name: 'networkDeploy'
  params: {
    location: location
    prefix: prefix
  }
}

// Registry module → external node, no invented edges.
module shared 'br/public:avm/res/network/virtual-network:0.1.0' = {
  name: 'sharedNet'
}

output storageId string = stg.id
output appName string = app.name
