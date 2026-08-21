#!/usr/bin/env node

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const PORT = 5173
const BROWSER = process.env.MOKKU_BROWSER || 'Dia'
const TIMEOUT = Number(process.env.MOKKU_TIMEOUT || 15000)
const TAB_GRACE_MS = 1600

const USAGE = `mokku — CLI bridge for the Mokku browser extension

Usage:
  mokku mock create --project <name> --method GET --url <url> [--status 200]
                    [--response '<json>'] [--delay <ms>] [--header 'Name: value']...
                    [--name <mock name>] [--inactive]
  mokku mock list [--project <name>]
  mokku mock update --id <localId> [--status <n>] [--response '<json>']
                    [--url <url>] [--method <m>] [--delay <ms>] [--active true|false]
  mokku mock delete --id <localId>
  mokku mock test --url <url> [--method GET]
  mokku mock repair [--project <name>]

  mokku project list
  mokku project create --name <name>
  mokku project delete --name <name>

  mokku raw --type <RPC_TYPE> [--data '<json>']

Environment variables:
  MOKKU_BROWSER   browser to open (default: Dia)
  MOKKU_TIMEOUT   milliseconds to wait for the response (default: 15000)

URL matching (as implemented by the extension): a mock matches when its saved
url equals the request url exactly, or equals the request pathname (query
string stripped). Save the bare pathname (e.g. /api/tasks/) to match any query
string; save the full url to pin one exact request. Use "mock test" to check a
matching without touching the browser UI.

Requirements: the browser with the Mokku extension installed and port 5173 free.
The first command opens a bridge tab; keep it open and subsequent commands
will reuse it without opening new tabs.
`

const parseArgs = (argv) => {
  const positional = []
  const flags = {}
  const repeated = { header: [] }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const key = token.slice(2)
    if (key === 'inactive' || key === 'help') {
      flags[key] = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Option --${key} requires a value`)
    }
    index += 1
    if (key === 'header') {
      repeated.header.push(value)
      continue
    }
    flags[key] = value
  }

  return { positional, flags, headers: repeated.header }
}

const parseHeaders = (rawHeaders) =>
  rawHeaders.map((rawHeader) => {
    const separatorIndex = rawHeader.indexOf(':')
    if (separatorIndex === -1) {
      throw new Error(`Invalid header "${rawHeader}". Format: 'Name: value'`)
    }
    return {
      name: rawHeader.slice(0, separatorIndex).trim(),
      value: rawHeader.slice(separatorIndex + 1).trim(),
    }
  })

const requireFlag = (flags, name) => {
  const value = flags[name]
  if (!value) throw new Error(`Missing required option --${name}`)
  return value
}

const slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

// The extension matches static mocks with
// mocks.where({ url, dynamicKey: 0, method, requestType: 'REST' }).
// A mock missing any of these fields is invisible to the matcher, whatever its
// url, so every mock the CLI writes must carry them.
const MOCK_REQUIRED_FIELDS = {
  dynamic: false,
  requestType: 'REST',
  responseType: 'STATIC',
  operationName: '',
  description: '',
}

const buildPlan = ({ positional, flags, headers }) => {
  const [group, action] = positional

  if (group === 'mock' && action === 'create') {
    const url = requireFlag(flags, 'url')
    const method = (flags.method || 'GET').toUpperCase()
    return {
      command: 'mock:create',
      params: {
        projectName: requireFlag(flags, 'project'),
        mock: {
          name: flags.name || `${method} ${url}`,
          method,
          url,
          status: Number(flags.status || 200),
          response: flags.response ?? '',
          headers: parseHeaders(headers),
          delay: Number(flags.delay || 0),
          active: !flags.inactive,
          ...MOCK_REQUIRED_FIELDS,
        },
      },
    }
  }

  if (group === 'mock' && action === 'list') {
    return { command: 'mock:list', params: { projectName: flags.project || null } }
  }

  if (group === 'mock' && action === 'update') {
    const changes = {}
    if (flags.status !== undefined) changes.status = Number(flags.status)
    if (flags.response !== undefined) changes.response = flags.response
    if (flags.url !== undefined) changes.url = flags.url
    if (flags.method !== undefined) changes.method = flags.method.toUpperCase()
    if (flags.delay !== undefined) changes.delay = Number(flags.delay)
    if (flags.active !== undefined) changes.active = flags.active === 'true'
    if (headers.length > 0) changes.headers = parseHeaders(headers)
    if (Object.keys(changes).length === 0) {
      throw new Error('mock update requires at least one field to change')
    }
    return {
      command: 'mock:update',
      params: { localId: Number(requireFlag(flags, 'id')), changes },
    }
  }

  if (group === 'mock' && action === 'test') {
    return {
      command: 'mock:test',
      params: {
        url: requireFlag(flags, 'url'),
        method: (flags.method || 'GET').toUpperCase(),
      },
    }
  }

  if (group === 'mock' && action === 'repair') {
    return { command: 'mock:repair', params: { projectName: flags.project || null } }
  }

  if (group === 'mock' && action === 'delete') {
    return { command: 'mock:delete', params: { localId: Number(requireFlag(flags, 'id')) } }
  }

  if (group === 'project' && action === 'list') {
    return { command: 'project:list', params: {} }
  }

  if (group === 'project' && action === 'create') {
    const name = requireFlag(flags, 'name')
    return { command: 'project:create', params: { name, slug: flags.slug || slugify(name) } }
  }

  if (group === 'project' && action === 'delete') {
    return { command: 'project:delete', params: { name: requireFlag(flags, 'name') } }
  }

  if (group === 'raw') {
    let data = {}
    if (flags.data) {
      try {
        data = JSON.parse(flags.data)
      } catch {
        throw new Error('--data must be valid JSON')
      }
    }
    return { command: 'raw', params: { type: requireFlag(flags, 'type'), data } }
  }

  throw new Error(`Unknown command: ${[group, action].filter(Boolean).join(' ') || '(empty)'}`)
}

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>mokku-bridge</title></head>
<body>
<p id="status">mokku-bridge: waiting for jobs… Keep this tab open: subsequent
CLI commands reuse it instead of opening new tabs.</p>
<script>
const status = document.getElementById('status')
const IDLE_TEXT = status.textContent

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const post = (path, body) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const sendOnce = (type, data, timeoutMs) =>
  new Promise((resolve, reject) => {
    const id = 'mokku-bridge-' + Math.random().toString(36).slice(2)
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error('timeout waiting for Mokku response to ' + type))
    }, timeoutMs)

    const onMessage = (event) => {
      const message = event.data
      if (!message || message.extensionName !== 'MOKKU') return
      if (!message._mokku || message._mokku.destination !== 'APP') return
      if (message.id !== id) return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      const payload = message.data
      if (payload && payload.isError) {
        const error = payload.error || {}
        reject(new Error(type + ': ' + (error.message || 'unknown error')))
        return
      }
      resolve(payload)
    }

    window.addEventListener('message', onMessage)
    window.postMessage(
      { type, data, id, extensionName: 'MOKKU', _mokku: { destination: 'APP_SCRIPT', source: 'APP' } },
      '*',
    )
  })

const rpc = async (type, data = {}) => {
  let lastError
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await sendOnce(type, data, 4000)
    } catch (error) {
      lastError = error
      if (!String(error.message).startsWith('timeout')) throw error
      await sleep(600)
    }
  }
  throw lastError
}

const MOCK_REQUIRED_FIELDS = {
  dynamic: false,
  requestType: 'REST',
  responseType: 'STATIC',
  operationName: '',
  description: '',
}

const missingRequiredFields = (mock) =>
  Object.entries(MOCK_REQUIRED_FIELDS).filter(
    ([field, value]) =>
      mock[field] === undefined || (field === 'requestType' && mock[field] !== value),
  )

const unwrapMocks = (payload) => {
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.mocks)) return payload.mocks
  return []
}

const getAllMocks = async (projectLocalId) => {
  const data = { page: 0, limit: 1000 }
  if (projectLocalId !== undefined) data.projectLocalId = projectLocalId
  return unwrapMocks(await rpc('MOCK_GET_ALL', data))
}

const slugify = (name) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

const ensureProject = async (name) => {
  const projects = await rpc('PROJECTS_GET_ALL', {})
  const existing = (projects || []).find((project) => project.name === name)
  if (existing) return { project: existing, created: false }
  const organizations = await rpc('ORGANIZATION_GET_ALL', {})
  if (!organizations || organizations.length === 0) {
    throw new Error('Mokku has no organization available')
  }
  const project = await rpc('PROJECT_CREATE', {
    name,
    slug: slugify(name),
    organizationLocalId: organizations[0].localId,
    isLocal: true,
  })
  return { project, created: true }
}

const findProject = async (name) => {
  const projects = await rpc('PROJECTS_GET_ALL', {})
  const project = (projects || []).find((candidate) => candidate.name === name)
  if (!project) throw new Error('Project "' + name + '" does not exist')
  return project
}

const commands = {
  'mock:create': async (params) => {
    const { project, created } = await ensureProject(params.projectName)
    const mock = await rpc('MOCK_CREATE', { ...params.mock, projectLocalId: project.localId })
    return { project, projectCreated: created, mock }
  },
  'mock:list': async (params) => {
    if (!params.projectName) {
      const all = await getAllMocks()
      return { mocks: all, total: all.length }
    }
    const project = await findProject(params.projectName)
    const all = await getAllMocks(project.localId)
    const mocks = all.filter((mock) => mock.projectLocalId === project.localId)
    return { project, mocks, total: mocks.length }
  },
  'mock:update': async (params) => {
    const current = await rpc('MOCK_GET', { localId: params.localId })
    const mock = Array.isArray(current) ? current[0] : current
    if (!mock) throw new Error('Mock ' + params.localId + ' does not exist')
    const repairs = Object.fromEntries(missingRequiredFields(mock))
    const updated = { ...mock, ...repairs, ...params.changes }
    return rpc('MOCK_UPDATE', { localId: params.localId, mock: updated })
  },
  'mock:test': async (params) => {
    const checked = await rpc('CHECK_MOCK', {
      request: { url: params.url, method: params.method, fullUrl: params.url },
      debug: true,
    })
    const describe = (mocks) =>
      (mocks || []).map((mock) => ({
        localId: mock.localId,
        url: mock.url,
        method: mock.method,
        active: mock.active,
      }))
    const debug = checked.debug || {}
    return {
      request: { url: params.url, method: params.method },
      matched: Boolean(checked.mock),
      mock: checked.mock || null,
      candidates: {
        static: describe(debug.staticMocks),
        pathname: describe(debug.pathnameMocks),
        dynamic: describe(debug.dynamicMock),
        graphql: describe(debug.graphqlMocks),
      },
    }
  },
  'mock:repair': async (params) => {
    const project = params.projectName ? await findProject(params.projectName) : null
    const mocks = await getAllMocks(project ? project.localId : undefined)
    const scoped = project
      ? mocks.filter((mock) => mock.projectLocalId === project.localId)
      : mocks
    const repaired = []
    for (const mock of scoped) {
      const missing = missingRequiredFields(mock)
      if (missing.length === 0) continue
      const repairs = Object.fromEntries(missing)
      await rpc('MOCK_UPDATE', {
        localId: mock.localId,
        mock: { ...mock, ...repairs },
      })
      repaired.push({ localId: mock.localId, url: mock.url, fixed: Object.keys(repairs) })
    }
    return { checked: scoped.length, repaired, total: repaired.length }
  },
  'mock:delete': async (params) => rpc('MOCK_DELETE', { localId: params.localId }),
  'project:list': async () => {
    const projects = await rpc('PROJECTS_GET_ALL', {})
    return { projects: projects || [], total: (projects || []).length }
  },
  'project:create': async (params) => {
    const organizations = await rpc('ORGANIZATION_GET_ALL', {})
    if (!organizations || organizations.length === 0) {
      throw new Error('Mokku has no organization available')
    }
    const projects = await rpc('PROJECTS_GET_ALL', {})
    const existing = (projects || []).find((project) => project.name === params.name)
    if (existing) return { project: existing, created: false }
    const project = await rpc('PROJECT_CREATE', {
      name: params.name,
      slug: params.slug,
      organizationLocalId: organizations[0].localId,
      isLocal: true,
    })
    return { project, created: true }
  },
  'project:delete': async (params) => {
    const project = await findProject(params.name)
    const all = await getAllMocks(project.localId)
    const localIds = all
      .filter((mock) => mock.projectLocalId === project.localId)
      .map((mock) => mock.localId)
    if (localIds.length > 0) await rpc('MOCK_DELETE_BULK', { localIds })
    await rpc('PROJECT_DELETE', { localId: project.localId })
    return { project, deletedMocks: localIds }
  },
  raw: async (params) => rpc(params.type, params.data),
}

const runJob = async (job) => {
  status.textContent = 'mokku-bridge: running ' + job.command + '…'
  try {
    const run = commands[job.command]
    if (!run) throw new Error('Command not supported by the page: ' + job.command)
    const result = await run(job.params)
    await post('/result', { jobId: job.jobId, ok: true, result })
  } catch (error) {
    await post('/result', {
      jobId: job.jobId,
      ok: false,
      error: String(error && error.message ? error.message : error),
    })
  }
  status.textContent = IDLE_TEXT
}

const main = async () => {
  let contentScriptWarmedUp = false
  for (;;) {
    let job = null
    try {
      const response = await fetch('/job', { method: 'POST' })
      if (response.status === 200) job = await response.json()
    } catch {
      job = null
    }
    if (!job) {
      await sleep(700)
      continue
    }
    if (!contentScriptWarmedUp) {
      await sleep(1200)
      contentScriptWarmedUp = true
    }
    await runJob(job)
  }
}

main()
</script>
</body>
</html>
`

const openBrowser = () =>
  new Promise((resolve, reject) => {
    const url = `http://localhost:${PORT}/`
    execFile('open', ['-a', BROWSER, url], (error) => (error ? reject(error) : resolve()))
  })

const readBody = (request) =>
  new Promise((resolve) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
  })

const runPlan = (plan) =>
  new Promise((resolve, reject) => {
    const jobId = randomUUID()
    let dispatched = false
    let settled = false
    let openTabTimer = null

    const server = createServer(async (request, response) => {
      response.setHeader('access-control-allow-origin', '*')
      response.setHeader('connection', 'close')

      if (request.method === 'POST' && request.url === '/job') {
        await readBody(request)
        if (dispatched) {
          response.writeHead(204)
          response.end()
          return
        }
        dispatched = true
        clearTimeout(openTabTimer)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jobId, command: plan.command, params: plan.params }))
        return
      }

      if (request.method === 'POST' && request.url === '/result') {
        const body = await readBody(request)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
        if (body.jobId === jobId) finish(body)
        return
      }

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(PAGE)
    })

    const finish = (body) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(openTabTimer)
      if (server.closeAllConnections) server.closeAllConnections()
      server.close()
      if (body && body.ok) {
        resolve(body.result)
        return
      }
      reject(new Error((body && body.error) || 'Mokku returned no result'))
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `No response within ${TIMEOUT} ms. Check that ${BROWSER} is open, the Mokku extension is installed, and the bridge tab (localhost:${PORT}) is still open.`,
      })
    }, TIMEOUT)

    server.on('error', (error) => {
      clearTimeout(timer)
      clearTimeout(openTabTimer)
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${PORT} is busy (a Vite dev server, or another mokku command in flight?). Mokku only accepts that port: free it and retry.`,
          ),
        )
        return
      }
      reject(error)
    })

    server.listen(PORT, '127.0.0.1', () => {
      openTabTimer = setTimeout(async () => {
        if (dispatched || settled) return
        try {
          await openBrowser()
        } catch (error) {
          finish({ ok: false, error: `Could not open ${BROWSER}: ${error.message}` })
        }
      }, TAB_GRACE_MS)
    })
  })

const main = async () => {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(USAGE)
    process.exit(argv.length === 0 ? 1 : 0)
  }

  const plan = buildPlan(parseArgs(argv))
  const result = await runPlan(plan)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

  if (plan.command === 'mock:create' || plan.command === 'mock:update') {
    process.stderr.write(
      'Reminder: creating or editing mocks does not enable interception. Enable Mokku manually in your app tab (Mokku panel in DevTools or the extension popup).\n',
    )
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
