import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

function dictionary(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected a template object.')
  return Object.fromEntries(Object.entries(value))
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a template array.')
  return value
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected an ARM expression.')
  return value
}
function compile(file: string) {
  return dictionary(JSON.parse(execFileSync('az', ['bicep', 'build', '--file', file, '--stdout'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
  })))
}
function resources(template: Record<string, unknown>) {
  return array(template.resources).map(dictionary)
}
function resource(template: Record<string, unknown>, type: string) {
  const matches = resources(template).filter((item) => item.type === type)
  if (matches.length !== 1) throw new Error(`Expected one ${type} resource.`)
  return matches[0]!
}
function module(template: Record<string, unknown>, suffix: string) {
  const matches = resources(template).filter((item) =>
    item.type === 'Microsoft.Resources/deployments' &&
    (item.name === suffix || text(item.name).includes(`-${suffix}`)))
  if (matches.length !== 1) throw new Error(`Expected one ${suffix} module.`)
  return dictionary(matches[0]!.properties)
}
function splitArmArguments(expression: string, name: string): string[] {
  if (!expression.startsWith(`${name}(`) || !expression.endsWith(')')) throw new Error(`Expected ${name}().`)
  const body = expression.slice(name.length + 1, -1)
  const values: string[] = []
  let start = 0, depth = 0, quoted = false
  for (let index = 0; index < body.length; index++) {
    const character = body[index]
    if (character === "'") {
      if (quoted && body[index + 1] === "'") { index++; continue }
      quoted = !quoted
    } else if (!quoted) {
      if (character === '(') depth++
      else if (character === ')') depth--
      else if (character === ',' && depth === 0) { values.push(body.slice(start, index).trim()); start = index + 1 }
    }
  }
  if (quoted || depth !== 0) throw new Error('Unbalanced ARM expression.')
  values.push(body.slice(start).trim())
  return values
}
function objectArguments(expression: string) {
  const values = splitArmArguments(expression, 'createObject')
  if (values.length % 2) throw new Error('ARM object has an incomplete key/value pair.')
  return Object.fromEntries(values.filter((_, index) => index % 2 === 0).map((key, index) => [key, values[index * 2 + 1]!]))
}
function environmentVariable(template: Record<string, unknown>, type: string, name: string) {
  const properties = dictionary(resource(template, type).properties)
  const container = dictionary(array(dictionary(properties.template).containers)[0])
  const matches = array(container.env).map(dictionary).filter((item) => item.name === name)
  if (matches.length !== 1) throw new Error(`Expected one ${name} variable.`)
  return matches[0]!.value
}

let main: Record<string, unknown>
let subscription: Record<string, unknown>
beforeAll(() => {
  main = compile(fileURLToPath(new URL('../main.bicep', import.meta.url)))
  subscription = compile(fileURLToPath(new URL('../test-subscription.bicep', import.meta.url)))
}, 240_000)

describe('partner deployment contracts', () => {
  it('keeps the private default and restricts the network selector to two explicit modes', () => {
    const mode = dictionary(dictionary(main.parameters).storageAccessMode)
    expect(mode.defaultValue).toBe('private')
    expect(mode.allowedValues).toEqual(['private', 'public'])
    expect(dictionary(main.variables).usePrivateStorage).toBe("[equals(parameters('storageAccessMode'), 'private')]")
  })

  it('allows public networking only through the explicit selector and never enables anonymous/key access', () => {
    const storage = dictionary(resource(main, 'Microsoft.Storage/storageAccounts').properties)
    expect(storage.publicNetworkAccess).toBe("[if(variables('usePrivateStorage'), 'Disabled', 'Enabled')]")
    expect(dictionary(storage.networkAcls).defaultAction).toBe("[if(variables('usePrivateStorage'), 'Deny', 'Allow')]")
    expect(storage.allowBlobPublicAccess).toBe(false)
    expect(storage.allowSharedKeyAccess).toBe(false)
    expect(storage.supportsHttpsTrafficOnly).toBe(true)
    for (const item of resources(main).filter((item) => item.type === 'Microsoft.Storage/storageAccounts/blobServices/containers')) {
      expect(dictionary(item.properties).publicAccess).toBe('None')
    }
  })

  it('omits all seven private network resources in public mode', () => {
    const network = resources(main).filter((item) => text(item.type).startsWith('Microsoft.Network/'))
    expect(network).toHaveLength(7)
    for (const item of network) expect(item.condition).toBe("[variables('usePrivateStorage')]")
    expect(dictionary(dictionary(main.outputs).virtualNetworkName).value).toContain("if(variables('usePrivateStorage')")
    expect(dictionary(dictionary(main.outputs).blobPrivateEndpointName).value).toContain("if(variables('usePrivateStorage')")
  })

  it('preserves the private VNet branch and creates only Consumption in the public branch', () => {
    const environment = resource(main, 'Microsoft.App/managedEnvironments')
    const properties = text(environment.properties).slice(1, -1)
    const network = splitArmArguments(properties, 'union')[1]!
    const [condition, privateBranch, publicBranch] = splitArmArguments(network, 'if')
    expect(condition).toBe("variables('usePrivateStorage')")
    const privateProperties = objectArguments(privateBranch!)
    expect(Object.keys(privateProperties)).toEqual(["'vnetConfiguration'"])
    const vnet = objectArguments(privateProperties["'vnetConfiguration'"]!)
    expect(vnet["'infrastructureSubnetId'"]).toContain('aca-infrastructure')
    expect(vnet["'internal'"]).toBe('false()')
    const publicProperties = objectArguments(publicBranch!)
    expect(Object.keys(publicProperties)).toEqual(["'workloadProfiles'"])
    const profiles = splitArmArguments(publicProperties["'workloadProfiles'"]!, 'createArray')
    expect(profiles).toHaveLength(1)
    expect(objectArguments(profiles[0]!)).toEqual({
      "'name'": "'Consumption'", "'workloadProfileType'": "'Consumption'",
    })
  })

  it('uses identical partner sender/domain parameters in Web, Usage and Mail', () => {
    expect(environmentVariable(main, 'Microsoft.App/containerApps', 'MAIL_SENDER_MAILBOX')).toBe("[parameters('mailSenderMailbox')]")
    expect(environmentVariable(main, 'Microsoft.App/containerApps', 'MAIL_ALLOWED_DOMAINS')).toBe("[join(parameters('mailAllowedRecipientDomains'), ',')]")
    for (const suffix of ['usage', 'mail']) {
      const item = module(main, suffix)
      const parameters = dictionary(item.parameters)
      expect(dictionary(parameters.senderMailbox).value).toBe("[parameters('mailSenderMailbox')]")
      expect(dictionary(parameters.allowedRecipientDomains).value).toBe("[parameters('mailAllowedRecipientDomains')]")
      const child = dictionary(item.template)
      expect(environmentVariable(child, 'Microsoft.App/jobs', 'MAIL_SENDER_MAILBOX')).toBe("[parameters('senderMailbox')]")
      expect(environmentVariable(child, 'Microsoft.App/jobs', 'MAIL_ALLOWED_DOMAINS')).toBe("[join(parameters('allowedRecipientDomains'), ',')]")
    }
  })

  it('preserves the existing private environment name and forwards options through the test entry point', () => {
    expect(dictionary(main.variables).environmentName).toBe(
      "[if(variables('usePrivateStorage'), format('{0}-cae-private', parameters('namePrefix')), format('{0}-cae-public', parameters('namePrefix')))]",
    )
    const parameters = dictionary(module(subscription, 'first-batch').parameters)
    for (const key of ['storageAccessMode', 'mailSenderMailbox', 'mailAllowedRecipientDomains']) {
      expect(dictionary(parameters[key]).value).toBe(`[parameters('${key}')]`)
    }
  })

  it('keeps real email off by default and leaves all schedules/timeouts unchanged', () => {
    expect(dictionary(dictionary(main.parameters).mailAuthorizationReady).defaultValue).toBe(false)
    const auth = dictionary(resource(main, 'Microsoft.App/jobs').properties)
    expect(dictionary(dictionary(auth.configuration).scheduleTriggerConfig).cronExpression).toBe('10 * * * *')
    for (const [suffix, cron, timeout] of [
      ['usage', '15 * * * *', 1500], ['pricing', '0 16 * * *', 1800], ['mail', '*/2 * * * *', 420],
    ] as const) {
      const child = dictionary(module(main, suffix).template)
      const configuration = dictionary(dictionary(resource(child, 'Microsoft.App/jobs').properties).configuration)
      expect(dictionary(configuration.scheduleTriggerConfig).cronExpression).toBe(cron)
      expect(configuration.replicaTimeout).toBe(timeout)
    }
  })

  it('ships a bootstrap-only public example with partner placeholders and a preserved-policy input', () => {
    const sample = dictionary(JSON.parse(readFileSync(new URL('../partner-public.parameters.example.json', import.meta.url), 'utf8')))
    const parameters = dictionary(sample.parameters)
    for (const [name, parameter] of Object.entries(parameters)) {
      expect(dictionary(main.parameters)[name]).toBeDefined()
      expect(dictionary(parameter)).toHaveProperty('value')
    }
    expect(dictionary(parameters.storageAccessMode).value).toBe('public')
    expect(dictionary(parameters.deployWebApp).value).toBe(false)
    expect(dictionary(parameters.containerImage).value).toBe('')
    expect(dictionary(parameters.mailAuthorizationReady).value).toBe(false)
    expect(dictionary(parameters.mailSenderMailbox).value).toBe('alerts@partner.example')
    expect(dictionary(parameters.mailAllowedRecipientDomains).value).toEqual(['partner.example'])
    expect(dictionary(parameters.existingStorageLifecycleRules).value).toEqual([])
  })
})
