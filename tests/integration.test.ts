import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { TopStatsDiscord } from '../src/index'

/**
 * A stand-in for a discord.js Client: a real EventEmitter carrying the cache
 * fields the integration reads. Nothing here touches discord.js or the
 * network - fetch is stubbed and every request it would have made is
 * recorded.
 */
class FakeClient extends EventEmitter {
  guilds = { cache: { size: 3 } }
  users = { cache: { size: 250 } }
  channels = { cache: { size: 40 } }
  ws = { ping: 42 }
}

interface RecordedRequest {
  url: string
  authorization: string
  events: Record<string, unknown>[]
}

const recorded: RecordedRequest[] = []

beforeEach(() => {
  recorded.length = 0

  vi.stubGlobal(
    'fetch',
    async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      const body = JSON.parse(String(init?.body)) as {
        events: Record<string, unknown>[]
      }

      recorded.push({
        url: String(url),
        authorization: headers.get('authorization') ?? '',
        events: body.events,
      })

      return new Response(JSON.stringify({ accepted: body.events.length }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    },
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function allEvents(): Record<string, unknown>[] {
  return recorded.flatMap((request) => request.events)
}

function eventNamed(name: string): Record<string, unknown> {
  const match = allEvents().find((event) => event.name === name)

  if (match === undefined) {
    throw new Error(`no ${name} event captured; saw ${JSON.stringify(allEvents())}`)
  }

  return match
}

function integration(
  client: FakeClient,
  extra?: Partial<ConstructorParameters<typeof TopStatsDiscord>[1]>,
): TopStatsDiscord {
  return new TopStatsDiscord(client, {
    apiKey: 'ts_test_fake_key_for_unit_tests_only',
    heartbeatSeconds: 0,
    ...extra,
  })
}

test('guild joins and leaves become events with the guild as the actor', async () => {
  const client = new FakeClient()
  const topstats = integration(client)

  client.emit('guildCreate', { id: 'g1', name: 'Cool Server', memberCount: 120 })
  client.emit('guildDelete', { id: 'g1', name: 'Cool Server' })
  await topstats.destroy()

  const join = eventNamed('guild_join')
  expect(join.properties).toEqual({ member_count: 120 })
  expect(join._actor).toBe('g1')
  expect(join._actorLabel).toBe('Cool Server')

  const leave = eventNamed('guild_leave')
  expect(leave._actor).toBe('g1')
})

test('slash commands become command_used with the user as the actor', async () => {
  const client = new FakeClient()
  const topstats = integration(client)

  client.emit('interactionCreate', {
    isChatInputCommand: () => true,
    commandName: 'play',
    guildId: 'g1',
    user: { id: 'u1', username: 'ada' },
  })
  // Non-command interactions are ignored.
  client.emit('interactionCreate', { isChatInputCommand: () => false })
  await topstats.destroy()

  const used = eventNamed('command_used')
  expect(used.properties).toEqual({ command: 'play', guild_id: 'g1' })
  expect(used._actor).toBe('u1')
  expect(used._actorLabel).toBe('ada')
  expect(allEvents().filter((event) => event.name === 'command_used')).toHaveLength(1)
})

test('messages are off by default and bot authors are skipped when on', async () => {
  const silent = new FakeClient()
  const quiet = integration(silent)
  silent.emit('messageCreate', { author: { id: 'u1', username: 'ada' } })
  await quiet.destroy()
  expect(allEvents().filter((event) => event.name === 'message_sent')).toHaveLength(0)

  const chatty = new FakeClient()
  const tracking = integration(chatty, { events: { messages: true } })
  chatty.emit('messageCreate', { author: { id: 'u1', username: 'ada' }, guildId: 'g1' })
  chatty.emit('messageCreate', { author: { id: 'b1', username: 'bot', bot: true } })
  await tracking.destroy()

  const sent = allEvents().filter((event) => event.name === 'message_sent')
  expect(sent).toHaveLength(1)
  expect(sent[0]?._actor).toBe('u1')
})

test('ready, shard events, and errors are tracked without content', async () => {
  const client = new FakeClient()
  const topstats = integration(client)

  client.emit('ready')
  client.emit('shardDisconnect', { code: 1006 }, 2)
  client.emit('shardResume', 2)
  client.emit('error', new Error('socket hang up'))
  await topstats.destroy()

  expect(eventNamed('bot_ready').properties).toEqual({ guilds: 3 })
  expect(eventNamed('shard_disconnect').properties).toEqual({
    shard_id: 2,
    code: 1006,
  })
  expect(eventNamed('shard_resume').properties).toEqual({ shard_id: 2 })
  expect(eventNamed('bot_error').properties).toEqual({ message: 'socket hang up' })
})

test('the heartbeat captures bot_stats with the cache sizes', async () => {
  vi.useFakeTimers()

  try {
    const client = new FakeClient()
    const topstats = integration(client, { heartbeatSeconds: 30 })

    vi.advanceTimersByTime(30_000)

    vi.useRealTimers()
    await topstats.destroy()

    const stats = eventNamed('bot_stats')
    const properties = stats.properties as Record<string, unknown>
    expect(properties.guilds).toBe(3)
    expect(properties.cached_users).toBe(250)
    expect(properties.cached_channels).toBe(40)
    expect(properties.ws_ping).toBe(42)
    expect(typeof properties.memory_used_mb).toBe('number')
  } finally {
    vi.useRealTimers()
  }
})

test('track sends custom events and destroy detaches every listener', async () => {
  const client = new FakeClient()
  const topstats = integration(client)

  topstats.track('order_completed', { amount: 5 }, { actor: 'u1', actorLabel: 'ada' })
  await topstats.destroy()

  const custom = eventNamed('order_completed')
  expect(custom.properties).toEqual({ amount: 5 })
  expect(custom._actor).toBe('u1')
  expect(custom._source).toBe('discord')

  // After destroy, discord events no longer produce captures.
  const before = allEvents().length
  client.emit('guildCreate', { id: 'g2', name: 'Late' })
  await topstats.destroy()
  expect(allEvents().length).toBe(before)
  expect(client.listenerCount('guildCreate')).toBe(0)
})

test('every request carries the api key and hits the events endpoint', async () => {
  const client = new FakeClient()
  const topstats = integration(client)

  topstats.track('anything')
  await topstats.destroy()

  expect(recorded.length).toBeGreaterThan(0)
  expect(recorded[0]?.url).toBe('https://topstats.gg/v1/events')
  expect(recorded[0]?.authorization).toBe(
    'Bearer ts_test_fake_key_for_unit_tests_only',
  )
})
