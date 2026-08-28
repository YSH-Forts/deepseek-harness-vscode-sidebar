import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessClient, isRecord } from './HarnessClient.ts'

// Build a fake JSON-RPC server executable that responds to requests based on a
// script file, letting us exercise the HarnessClient wire protocol without the
// real Python runtime.
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-client-test-'))
})

afterAll(() => {
  // best-effort cleanup
})

function makeServer(script: string): string {
  const path = join(dir, `server-${Math.random().toString(36).slice(2)}.sh`)
  writeFileSync(path, script)
  chmodSync(path, 0o755)
  return path
}

// A server that echoes back a valid initialize response and a history response,
// then relays notifications for subscribed events.
function echoServer(): string {
  return makeServer(`#!/bin/bash
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
  method=$(echo "$line" | sed -n 's/.*"method":"\\([^"]*\\)".*/\\1/p')
  case "$method" in
    initialize) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"serverInfo\\":{\\"name\\":\\"test\\",\\"version\\":\\"1.0\\"}}}";;
    session/history) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"events\\":[{\\"type\\":\\"user/message\\",\\"seq\\":1,\\"data\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"hi\\"}]}}]}}";;
    session/list) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"items\\":[{\\"id\\":\\"s1\\",\\"title\\":\\"One\\",\\"createdAt\\":1,\\"updatedAt\\":2}]}}";;
    commands/list) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"items\\":[{\\"name\\":\\"goal\\",\\"description\\":\\"set a goal\\",\\"input\\":{\\"hint\\":\\"[objective]\\"}}]}}";;
    approval/list) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"items\\":[{\\"sessionId\\":\\"s1\\",\\"approvalId\\":\\"a1\\",\\"toolName\\":\\"bash\\"}]}}";;
    credentials/describe) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"configured\\":false,\\"writable\\":true}}";;
    credentials/set) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"configured\\":true,\\"writable\\":true,\\"source\\":\\"file\\"}}";;
    credentials/unset) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"configured\\":false,\\"writable\\":true}}";;
    session/prompt) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"messageId\\":\\"m1\\"}}";;
    session/cancel) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"accepted\\":true}}";;
    session/steer) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"accepted\\":true}}";;
    approval/respond) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"accepted\\":false}}";;
    shutdown) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{}}"; exit 0;;
    *) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{}}";;
  esac
done
`)
}

function startClient(serverPath: string, promptTimeoutMs?: number): HarnessClient {
  const client = new HarnessClient({ command: serverPath, args: [], cwd: dir, env: {}, ...(promptTimeoutMs === undefined ? {} : { promptTimeoutMs }) })
  client.start()
  return client
}

describe('HarnessClient protocol', () => {
  it('initialize returns parsed serverInfo', async () => {
    const client = startClient(echoServer())
    const info = await client.initialize({ cwd: dir, provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(info).toEqual({ serverInfo: { name: 'test', version: '1.0' } })
    await client.close()
  })

  it('history returns array of raw events', async () => {
    const client = startClient(echoServer())
    const events = await client.history('s1')
    expect(events.events).toHaveLength(1)
    expect(events.events[0]).toEqual({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }] } })
    await client.close()
  })

  it('prompt resolves for a valid messageId response', async () => {
    const client = startClient(echoServer())
    await expect(client.prompt('s1', [{ type: 'text', text: 'hi' }])).resolves.toBeUndefined()
    await client.close()
  })

  it('lists sessions and approvals and manages credential status without returning secrets', async () => {
    const client = startClient(echoServer())
    await expect(client.listSessions()).resolves.toEqual([{ id: 's1', title: 'One', createdAt: 1, updatedAt: 2 }])
    await expect(client.listApprovals('s1')).resolves.toEqual([{ sessionId: 's1', approvalId: 'a1', toolName: 'bash' }])
    await expect(client.listCommands()).resolves.toEqual([{ name: 'goal', description: 'set a goal', input: { hint: '[objective]' } }])
    await expect(client.credentialStatus()).resolves.toEqual({ configured: false, writable: true })
    await expect(client.setCredential('secret')).resolves.toEqual({ configured: true, writable: true, source: 'file' })
    await expect(client.unsetCredential()).resolves.toEqual({ configured: false, writable: true })
    await client.close()
  })

  it('mutation methods return boolean accepted', async () => {
    const client = startClient(echoServer())
    await expect(client.cancel('s1')).resolves.toBe(true)
    await expect(client.steer('s1', [{ type: 'text', text: 'x' }])).resolves.toBe(true)
    await expect(client.respondApproval('s1', 'a1', 'allowed-once')).resolves.toBe(false)
    await client.close()
  })

  it('subscribe delivers notifications', async () => {
    const server = makeServer(`#!/bin/bash
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
  method=$(echo "$line" | sed -n 's/.*"method":"\\([^"]*\\)".*/\\1/p')
  case "$method" in
    initialize) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{\\"serverInfo\\":{\\"name\\":\\"t\\",\\"version\\":\\"1\\"}}}"
               echo "{\\"jsonrpc\\":\\"2.0\\",\\"method\\":\\"session.event\\",\\"params\\":{\\"sessionId\\":\\"s1\\",\\"event\\":{\\"type\\":\\"assistant/chunk\\",\\"seq\\":1,\\"data\\":{\\"chunk\\":{\\"type\\":\\"text-delta\\",\\"text\\":\\"hello\\"}}}}}";;
    *) echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{}}";;
  esac
done
`)
    const client = startClient(server)
    const received: string[] = []
    client.subscribe(n => { if (n.method === 'session.event') received.push(n.method) })
    await client.initialize({ cwd: dir, provider: 'p', model: 'm' })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(received).toEqual(['session.event'])
    await client.close()
  })

  it('times out when runtime never responds', async () => {
    // Server reads lines but never writes a response, so the request must hit
    // the timeout rather than an exit event.
    const server = makeServer(`#!/bin/bash\nwhile IFS= read -r line; do :; done\n`)
    const client = startClient(server, 350)
    const t0 = Date.now()
    await expect(client.prompt('s1', [{ type: 'text', text: 'hi' }])).rejects.toThrow(/timed out/)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300)
    await client.close()
  }, 20_000)

  it('rejects pending requests when the runtime exits unexpectedly', async () => {
    const server = makeServer(`#!/bin/bash\nexit 1\n`)
    const client = startClient(server)
    await expect(client.prompt('s1', [{ type: 'text', text: 'hi' }])).rejects.toThrow(/Runtime exited/)
  }, 10_000)

  it('rejects on JSON-RPC error responses', async () => {
    const server = makeServer(`#!/bin/bash
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
  method=$(echo "$line" | sed -n 's/.*"method":"\\([^"]*\\)".*/\\1/p')
  if [ "$method" = "session/prompt" ]; then
    echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"error\\":{\\"code\\":-32000,\\"message\\":\\"session validation failed\\"}}"
  else
    echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":$id,\\"result\\":{}}"
  fi
done
`)
    const client = startClient(server)
    await expect(client.prompt('s1', [{ type: 'text', text: 'hi' }])).rejects.toThrow(/session validation failed/)
    await client.close()
  })
})

describe('isRecord', () => {
  it('detects plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
    expect(isRecord(5)).toBe(false)
  })
})
