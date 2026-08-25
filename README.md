# TopStats for discord.js

The official TopStats Analytics integration for discord.js bots. Attach it to
your client and the events a bot owner wants charted flow into your TopStats
workspace with no tracking code of your own: guild joins and leaves, slash
command usage, shard health, errors, and a periodic stats heartbeat. A
`track()` method is there for your own events on the same buffered pipeline.

Nothing content-shaped is ever sent - no message text, no command options.

## Install

```bash
npm install @topstats/discord
```

## Quick start

```js
import { Client, GatewayIntentBits } from 'discord.js'
import { TopStatsDiscord } from '@topstats/discord'

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

const topstats = new TopStatsDiscord(client, {
  apiKey: process.env.TOPSTATS_KEY,
})

// That is the whole integration. Joins, leaves, commands, shard health, and
// bot stats now land in your workspace.

client.login(process.env.DISCORD_TOKEN)
```

## Your own events

```js
topstats.track('premium_purchased', { plan: 'gold' }, {
  actor: interaction.user.id,
  actorLabel: interaction.user.username,
})
```

`track(name, properties, context)` uses the same buffered, batched, retrying
client as the automatic events, and never throws.

## What gets tracked automatically

| Event | Properties | Actor |
| --- | --- | --- |
| `bot_ready` | `guilds` | |
| `guild_join` | `member_count` | the guild, labelled with its name |
| `guild_leave` | | the guild |
| `command_used` | `command`, `guild_id` | the user, labelled with their username |
| `message_sent` (off by default) | `guild_id` | the user |
| `shard_disconnect` | `shard_id`, `code` | |
| `shard_resume` | `shard_id` | |
| `bot_error` | `message` | |
| `bot_stats` every 60s | `guilds`, `cached_users`, `cached_channels`, `ws_ping`, `memory_used_mb`, `uptime_seconds` | |

Guild events use the guild id as the actor and users use their user id, so
renames never split history. `message_sent` is off by default because it is
high volume on busy bots; it carries no message content when enabled.

## Options

```js
new TopStatsDiscord(client, {
  apiKey: 'ts_live_your_key',
  source: 'my-bot',
  heartbeatSeconds: 60,
  events: {
    lifecycle: true,
    guilds: true,
    commands: true,
    messages: false,
    shards: true,
    errors: true,
  },
})
```

| Option | Default | What it does |
| --- | --- | --- |
| `apiKey` | required | Your workspace API key. |
| `host` | `https://topstats.gg` | API origin override. |
| `source` | `discord` | The `_source` label on every event. |
| `heartbeatSeconds` | 60 | Seconds between `bot_stats`. 0 disables them. |
| `events.*` | see above | Toggles per automatic event group. |

## Shutdown

```js
await topstats.destroy()
```

Detaches every listener, stops the heartbeat, and flushes the buffered tail.
Call it before your process exits so the last events are not lost.

## Requirements

- Node.js 18 or later
- discord.js 14 or later (attached structurally, so nothing breaks at
  runtime if you are slightly off this range)

Full product documentation: <https://docs.topstats.gg/docs/analytics>
