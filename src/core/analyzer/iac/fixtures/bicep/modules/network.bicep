// A local module target. Declares `param location` too — the same symbol name as
// main.bicep, to prove references are file-scoped and never cross-link.
param location string
param prefix string

resource vnet 'Microsoft.Network/virtualNetworks@2023-01-01' = {
  name: '${prefix}-vnet'
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/16'
      ]
    }
  }

  resource subnet 'subnets' = {
    name: 'default'
    properties: {
      addressPrefix: '10.0.0.0/24'
    }
  }
}

output vnetId string = vnet.id
