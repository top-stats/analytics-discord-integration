import { TopStats } from '@topstats/analytics'

/**
 * The slice of a discord.js Client this integration touches, described
 * structurally so a real Client satisfies it and tests can hand in a plain
 * EventEmitter. Everything beyond the emitter surface is optional and read
 * defensively, because shards and caches vary by configuration.
 */
export interface DiscordClientLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
  guilds?: { cache: { size: number } }
  users?: { cache: { size: number } }
  channels?: { cache: { size: number } }
  ws?: { ping: number }
}

export interface TopStatsDiscordOptions {
  /** Your workspace API key (ts_live_... or ts_test_...). Required. */
  apiKey: string
  /** API origin override; also the TOPSTATS_HOST env var. */
  host?: string
  /** The _source label on every event. Defaults to 'discord'. */
  source?: string
  /** Seconds between bot_stats heartbeats. 0 disables them. */
  heartbeatSeconds?: number
  /** Which automatic events are tracked. Everything except messages is on. */
  events?: {
    /** bot_ready when the client comes online. */
    lifecycle?: boolean
    /** guild_join and guild_leave. */
    guilds?: boolean
    /** command_used for slash commands. */
    commands?: boolean
    /** message_sent counts. Off by default: high volume on busy bots. */
    messages?: boolean
    /** shard_disconnect and shard_resume. */
    shards?: boolean
    /** bot_error when the client emits an error. */
    errors?: boolean
  }
}

interface TrackContext {
  actor?: string
  actorLabel?: string
  source?: string
  timestamp?: Date
}

interface GuildLike {
  id?: unknown
  name?: unknown
  memberCount?: unknown
}

interface InteractionLike {
  isChatInputCommand?: () => boolean
  commandName?: unknown
  guildId?: unknown
  user?: { id?: unknown; username?: unknown }
}

interface MessageLike {
  author?: { id?: unknown; username?: unknown; bot?: unknown }
  guildId?: unknown
}

/**
 * Attaches to a discord.js client and tracks what a bot owner wants charted
 * without them posting a single event: lifecycle, guild joins and leaves,
 * slash command usage, shard health, and a periodic bot_stats heartbeat.
 * Nothing content-shaped is ever sent - no message text, no command options.
 *
 * `track()` is the escape hatch for your own events on the same buffered
 * client.
 */
export class TopStatsDiscord {
  private readonly sdk: TopStats
  private readonly client: DiscordClientLike
  private readonly listeners: [string, (...args: unknown[]) => void][] = []
  private readonly startedAtMillis = Date.now()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private destroyed = false

  constructor(client: DiscordClientLike, options: TopStatsDiscordOptions) {
    this.client = client
    const sdkOptions: ConstructorParameters<typeof TopStats>[1] = {
      defaultSource: options.source ?? 'discord',
    }

    if (options.host !== undefined) {
      sdkOptions.host = options.host
    }

    this.sdk = new TopStats(options.apiKey, sdkOptions)

    const events = options.events ?? {}

    if (events.lifecycle !== false) {
      this.listen('ready', () => {
        this.sdk.capture('bot_ready', { guilds: this.guildCount() })
      })
    }

    if (events.guilds !== false) {
      this.listen('guildCreate', (...args: unknown[]) => {
        const guild = asObject<GuildLike>(args[0])
        this.sdk.capture(
          'guild_join',
          { member_count: numberOr(guild.memberCount, 0) },
          guildContext(guild),
        )
      })
      this.listen('guildDelete', (...args: unknown[]) => {
        const guild = asObject<GuildLike>(args[0])
        this.sdk.capture('guild_leave', undefined, guildContext(guild))
      })
    }

    if (events.commands !== false) {
      this.listen('interactionCreate', (...args: unknown[]) => {
        const interaction = asObject<InteractionLike>(args[0])
        if (
          typeof interaction.isChatInputCommand !== 'function' ||
          !interaction.isChatInputCommand()
        ) {
          return
        }

        const properties: Record<string, unknown> = {
          command: stringOr(interaction.commandName, 'unknown'),
        }

        const guildId = stringOr(interaction.guildId, '')

        if (guildId !== '') {
          properties.guild_id = guildId
        }

        this.sdk.capture('command_used', properties, userContext(interaction.user))
      })
    }

    if (events.messages === true) {
      this.listen('messageCreate', (...args: unknown[]) => {
        const message = asObject<MessageLike>(args[0])
        if (message.author?.bot === true) {
          return
        }

        const properties: Record<string, unknown> = {}
        const guildId = stringOr(message.guildId, '')

        if (guildId !== '') {
          properties.guild_id = guildId
        }

        this.sdk.capture('message_sent', properties, userContext(message.author))
      })
    }

    if (events.shards !== false) {
      this.listen('shardDisconnect', (...args: unknown[]) => {
        const event = asObject<{ code?: unknown }>(args[0])
        this.sdk.capture('shard_disconnect', {
          shard_id: numberOr(args[1], -1),
          code: numberOr(event.code, 0),
        })
      })
      this.listen('shardResume', (...args: unknown[]) => {
        this.sdk.capture('shard_resume', { shard_id: numberOr(args[0], -1) })
      })
    }

    if (events.errors !== false) {
      this.listen('error', (...args: unknown[]) => {
        const error = asObject<{ message?: unknown }>(args[0])
        this.sdk.capture('bot_error', {
          message: stringOr(error.message, 'unknown error'),
        })
      })
    }

    const heartbeatSeconds = options.heartbeatSeconds ?? 60

    if (heartbeatSeconds > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.captureStats()
      }, heartbeatSeconds * 1000)

      // The heartbeat must never keep the process alive.
      if (typeof this.heartbeatTimer.unref === 'function') {
        this.heartbeatTimer.unref()
      }
    }
  }

  /**
   * Sends your own event through the same buffered client the automatic
   * events use. Never throws.
   */
  track(
    name: string,
    properties?: Record<string, unknown>,
    context?: TrackContext,
  ): void {
    this.sdk.capture(name, properties, context)
  }

  /** Sends everything buffered and resolves when done. */
  flush(): Promise<void> {
    return this.sdk.flush()
  }

  /**
   * Detaches every listener, stops the heartbeat, and flushes the buffered
   * tail. Safe to call twice.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) {
      return
    }

    this.destroyed = true

    for (const [event, listener] of this.listeners) {
      this.client.removeListener(event, listener)
    }

    this.listeners.length = 0

    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    await this.sdk.shutdown()
  }

  private listen(event: string, listener: (...args: unknown[]) => void): void {
    this.client.on(event, listener)
    this.listeners.push([event, listener])
  }

  private captureStats(): void {
    const memory = process.memoryUsage()

    const stats: Record<string, unknown> = {
      guilds: this.guildCount(),
      cached_users: sizeOf(this.client.users),
      cached_channels: sizeOf(this.client.channels),
      memory_used_mb: Math.round((memory.heapUsed / 1024 / 1024) * 100) / 100,
      uptime_seconds: Math.floor((Date.now() - this.startedAtMillis) / 1000),
    }

    const ping = this.client.ws?.ping

    // discord.js reports -1 before the first heartbeat answer arrives.
    if (typeof ping === 'number' && ping >= 0) {
      stats.ws_ping = ping
    }

    this.sdk.capture('bot_stats', stats)
  }

  private guildCount(): number {
    return sizeOf(this.client.guilds)
  }
}

function asObject<T extends object>(value: unknown): Partial<T> {
  if (typeof value === 'object' && value !== null) {
    return value as Partial<T>
  }

  return {}
}

function sizeOf(collection: { cache: { size: number } } | undefined): number {
  if (collection === undefined) {
    return 0
  }

  return collection.cache.size
}

function guildContext(guild: GuildLike): TrackContext {
  const context: TrackContext = {}
  const id = stringOr(guild.id, '')

  if (id !== '') {
    context.actor = id
  }

  const name = stringOr(guild.name, '')

  if (name !== '') {
    context.actorLabel = name
  }

  return context
}

function userContext(
  user: { id?: unknown; username?: unknown } | undefined,
): TrackContext {
  const context: TrackContext = {}
  const id = stringOr(user?.id, '')

  if (id !== '') {
    context.actor = id
  }

  const username = stringOr(user?.username, '')

  if (username !== '') {
    context.actorLabel = username
  }

  return context
}

function stringOr(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    return value
  }

  return fallback
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  return fallback
}
