import type { Context } from 'cordis'
import type {} from '@cordisjs/plugin-database'
import type { Bot } from '@satorijs/core'

export interface BlacklistEntry {
  /** `platform:userId`。 */
  id: string
  platform: string
  userId: string
  /** 拉黑时记下的名称，未知为空字符串。 */
  name: string
  /** 拉黑时取到的头像地址，未知为空字符串。 */
  avatar: string
  reason: string
  /** 发起拉黑的用户 `platform:userId`，没有发起人时为空字符串。 */
  operator: string
  createdAt: number
  /** 到期时间戳；0 表示永久。到期的记录不再生效，下次加载时从数据库删除。 */
  expiresAt: number
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    chatluna_blacklist: BlacklistEntry
  }
}

declare module 'cordis' {
  interface Events {
    /** 黑名单增删后触发，WebUI 的 `blacklist.list` 据此推送。 */
    'blacklist/change'(): void
  }
}

export interface BlacklistInput {
  platform: string
  userId: string
  name?: string
  avatar?: string
  reason: string
  operator?: string
  /** 拉黑时长（毫秒）；不填或 0 表示永久。 */
  duration?: number
}

export const keyOf = (platform: string, userId: string) => `${platform}:${userId}`

const active = (entry: BlacklistEntry) => entry.expiresAt === 0 || entry.expiresAt > Date.now()

/**
 * 黑名单存在数据库里，启动时整表读进内存：每条入站消息都要查询，命中判断不能走数据库。
 * 写入先落库再改内存，失败时内存与数据库保持一致。到期的记录在内存里按未拉黑处理，不另设定时器清理。
 */
export class Blacklist {
  readonly ready: Promise<void>
  private readonly entries = new Map<string, BlacklistEntry>()

  constructor(private readonly ctx: Context) {
    ctx.model.extend('chatluna_blacklist', {
      id: 'string',
      platform: 'string',
      userId: 'string',
      name: 'string',
      avatar: 'text',
      reason: 'text',
      operator: 'string',
      createdAt: 'integer',
      expiresAt: 'integer',
    }, { primary: 'id', unique: [['platform', 'userId']] })
    this.ready = this.load()
  }

  private async load() {
    await this.ctx.database.remove('chatluna_blacklist', { expiresAt: { $gt: 0, $lte: Date.now() } })
    for (const row of await this.ctx.database.get('chatluna_blacklist', {})) this.entries.set(row.id, row)
    this.ctx.emit('blacklist/change')
  }

  has(platform: string, userId: string | undefined) {
    return userId !== undefined && this.get(platform, userId) !== undefined
  }

  /** 只返回仍在生效的记录。 */
  get(platform: string, userId: string) {
    const entry = this.entries.get(keyOf(platform, userId))
    return entry && active(entry) ? entry : undefined
  }

  /** 按拉黑时间先后排列。 */
  list(platform?: string) {
    return [...this.entries.values()]
      .filter((entry) => active(entry) && (platform === undefined || entry.platform === platform))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 已在黑名单中时原样返回旧记录，不覆盖原理由和期限；已到期的旧记录直接覆盖。 */
  async add(input: BlacklistInput): Promise<{ entry: BlacklistEntry, created: boolean }> {
    const reason = input.reason.trim()
    if (!reason) throw new Error('拉黑必须填写理由。')
    await this.ready
    const existing = this.get(input.platform, input.userId)
    if (existing) return { entry: existing, created: false }
    const createdAt = Date.now()
    const entry: BlacklistEntry = {
      id: keyOf(input.platform, input.userId),
      platform: input.platform,
      userId: input.userId,
      name: input.name?.trim() ?? '',
      avatar: input.avatar ?? '',
      reason,
      operator: input.operator ?? '',
      createdAt,
      expiresAt: input.duration ? createdAt + input.duration : 0,
    }
    await this.ctx.database.upsert('chatluna_blacklist', [entry])
    this.entries.set(entry.id, entry)
    this.ctx.logger.info('blacklisted %s until %s: %s', entry.id, entry.expiresAt || 'forever', reason)
    this.ctx.emit('blacklist/change')
    return { entry, created: true }
  }

  /** 按 `platform:userId` 移除，返回被移除的生效记录；不在黑名单中或已到期时返回 undefined，到期记录顺带删除。 */
  async remove(id: string) {
    await this.ready
    const entry = this.entries.get(id)
    if (!entry) return
    await this.ctx.database.remove('chatluna_blacklist', { id })
    this.entries.delete(id)
    this.ctx.emit('blacklist/change')
    if (!active(entry)) return
    this.ctx.logger.info('unblacklisted %s', id)
    return entry
  }
}

/**
 * 拉黑时顺带记下的名称与头像，群里优先取群名片。平台不支持或查询失败时留空，不影响拉黑。
 */
export async function profileOf(bot: Bot | undefined, userId: string, guildId?: string): Promise<{ name?: string, avatar?: string }> {
  if (!bot) return {}
  const member = guildId === undefined ? undefined : await bot.getGuildMember(guildId, userId).catch(() => undefined)
  const user = member?.user ?? await bot.getUser(userId).catch(() => undefined)
  return { name: member?.nick || user?.nick || user?.name, avatar: member?.avatar || user?.avatar }
}

/** 名称未知时只显示 ID。 */
export const displayOf = (entry: BlacklistEntry) => entry.name ? `${entry.name}（${entry.userId}）` : entry.userId

const timeOf = (timestamp: number) => new Date(timestamp).toLocaleString('zh-CN', { hour12: false })

export const termOf = (entry: BlacklistEntry) => entry.expiresAt === 0 ? '永久' : `至 ${timeOf(entry.expiresAt)}`

/** 工具与指令共用的拉黑结果。 */
export function addedText({ entry, created }: { entry: BlacklistEntry, created: boolean }) {
  return created
    ? `已拉黑 ${displayOf(entry)}，期限：${termOf(entry)}，理由：${entry.reason}`
    : `${displayOf(entry)} 已在黑名单中，期限：${termOf(entry)}，原理由：${entry.reason}`
}

export function formatList(entries: BlacklistEntry[]) {
  if (!entries.length) return '黑名单为空。'
  return [
    `共 ${entries.length} 名已拉黑用户：`,
    ...entries.map((entry, index) => {
      return `${index + 1}. ${displayOf(entry)}，平台：${entry.platform}，理由：${entry.reason}，时间：${timeOf(entry.createdAt)}，期限：${termOf(entry)}`
    }),
  ].join('\n')
}
