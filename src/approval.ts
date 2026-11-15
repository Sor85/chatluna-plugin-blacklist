import type { Context } from 'cordis'
import { Time } from 'cosmokit'
import type {} from '@cordisjs/plugin-database'
import { type Bot, h, type Session } from '@satorijs/core'
import type {} from '@chatluna/chat'
import type {} from '@chatluna/chat-observer'
import type {} from '@chatluna/engine-setup-webui'
import type { ChatBlock } from '@chatluna/message'
import { addedText, type Blacklist, type BlacklistInput, displayOf, keyOf } from './blacklist'

/** 待主人决定的拉黑请示，处理后删除。 */
export interface BlacklistRequest {
  id: number
  platform: string
  userId: string
  name: string
  avatar: string
  reason: string
  operator: string
  /** 拉黑时长（毫秒），0 表示永久，从主人同意时起算。 */
  duration: number
  /** 发出请示的会话，例如 `群 30003`、`私聊`。 */
  place: string
  createdAt: number
  /** 发给主人的消息 ID，主人引用其中任一条回复时据此对应请示。 */
  messageIds: string[]
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    chatluna_blacklist_request: BlacklistRequest
  }
}

/** 主人一天内未处理的请示作废，之后可以重新请示。 */
export const REQUEST_TTL = Time.day

export interface Evidence {
  userId: string
  name: string
  time: number
  content: readonly ChatBlock[]
}

export interface RequestInput extends BlacklistInput {
  place: string
  selfId?: string
  evidence: Evidence[]
}

const DECISION = /^(同意|拒绝)\s*#?(\d+)?$/

const live = (request: BlacklistRequest) => request.createdAt + REQUEST_TTL > Date.now()

const durationOf = (duration: number) => duration ? `${Math.round(duration / Time.minute)} 分钟` : '永久'

/**
 * 文本原样保留，图片按地址重发，其余附件只留说明。
 * ChatLuna 把 @机器人 记成 `@self`（`@chatluna/transform`），会话记录又会把它和后面的正文并成一个文本块，
 * 所以在文本里替换回机器人名称。
 */
function elementsOf(content: readonly ChatBlock[], self: string): h[] {
  return content.flatMap((block): h[] => {
    if (block.type === 'text') return [h.text(block.text.replace(/@self\b/g, `@${self}`))]
    if (block.type === 'envelope') return elementsOf(block.content, self)
    if (block.type !== 'file') return []
    if (block.mediaType.startsWith('image/') && block.data.type === 'url') return [h.image(block.data.url)]
    return [h.text(`[${block.alt || block.filename || '文件'}]`)]
  })
}

/** OneBot 合并转发的每个节点都写 `<author>`，否则节点会沿用上一个节点的作者；其他平台退回逐行文本。 */
function evidenceOf(bot: Bot, evidence: Evidence[]): h | undefined {
  if (!evidence.length) return
  const self = bot.user?.name || bot.selfId
  if (bot.platform === 'onebot') {
    return h('message', { forward: true }, evidence.map((item) => h('message', { time: item.time }, [
      h('author', { id: item.userId, name: item.name || item.userId }),
      ...elementsOf(item.content, self),
    ])))
  }
  return h('message', {}, evidence.flatMap((item, index) => [
    ...index ? [h.text('\n')] : [],
    h.text(`${item.name || item.userId}：`),
    ...elementsOf(item.content, self),
  ]))
}

function requestText(request: BlacklistRequest, evidence: number) {
  return [
    `拉黑请示 #${request.id}`,
    `对象：${displayOf(request)}，平台：${request.platform}，${request.place}`,
    `时长：${durationOf(request.duration)}`,
    `理由：${request.reason}`,
    evidence ? `罪证：上方合并转发的 ${evidence} 条消息` : '罪证：未取到该用户的聊天记录',
    `回复「同意 ${request.id}」执行拉黑，「拒绝 ${request.id}」驳回；引用本消息回复「同意」或「拒绝」时可省略编号。24 小时内未处理自动作废。`,
  ].join('\n')
}

/**
 * 拉黑前请示主人：模型调用拉黑工具时只记下请示并私聊主人，主人同意后才写入黑名单。
 * 请示存数据库并整表读进内存，主人的每条私聊都要比对，不能走数据库；到期请示按不存在处理，加载时删除。
 * 主人取自 ChatLuna 初始设置绑定的主人（`chatluna_setup`），只私聊有在线机器人的平台。
 */
export class Approval {
  readonly ready: Promise<void>
  private readonly requests = new Map<number, BlacklistRequest>()

  constructor(private readonly ctx: Context, private readonly blacklist: Blacklist) {
    ctx.model.extend('chatluna_blacklist_request', {
      id: 'unsigned',
      platform: 'string',
      userId: 'string',
      name: 'string',
      avatar: 'text',
      reason: 'text',
      operator: 'string',
      duration: 'integer',
      place: 'string',
      createdAt: 'integer',
      messageIds: 'json',
    }, { autoInc: true })
    this.ready = this.load()
  }

  private async load() {
    await this.ctx.database.remove('chatluna_blacklist_request', { createdAt: { $lte: Date.now() - REQUEST_TTL } })
    for (const row of await this.ctx.database.get('chatluna_blacklist_request', {})) this.requests.set(row.id, row)
  }

  pending() {
    return [...this.requests.values()].filter(live).sort((a, b) => a.id - b.id)
  }

  private owners() {
    return (this.ctx.get('chatluna_setup')?.snapshot().owners ?? []).filter((owner) => owner.platform !== 'web')
  }

  /** 同平台优先用当前会话的机器人。 */
  private botOf(platform: string, selfId?: string) {
    const bots = (this.ctx.get('satori')?.bots ?? []).filter((bot) => bot.platform === platform && bot.isActive)
    return bots.find((bot) => bot.selfId === selfId) ?? bots[0]
  }

  /** 返回给模型的结果；没有能私聊的主人时抛错，不拉黑。 */
  async request(input: RequestInput) {
    const reason = input.reason.trim()
    if (!reason) throw new Error('拉黑必须填写理由。')
    await Promise.all([this.ready, this.blacklist.ready])
    const existing = this.blacklist.get(input.platform, input.userId)
    if (existing) return addedText({ entry: existing, created: false })
    const target = displayOf({ name: input.name?.trim() ?? '', userId: input.userId })
    const repeated = this.pending().find((request) => request.platform === input.platform && request.userId === input.userId)
    if (repeated) return `已就拉黑 ${target} 请示过主人（#${repeated.id}），尚未答复，主人同意前不会拉黑。`

    const targets = this.owners().flatMap((owner) => {
      const bot = this.botOf(owner.platform, owner.platform === input.platform ? input.selfId : undefined)
      return bot ? [{ owner, bot }] : []
    })
    if (!targets.length) throw new Error('没有可私聊的主人，无法请示，未拉黑。')

    const request = await this.ctx.database.create('chatluna_blacklist_request', {
      platform: input.platform,
      userId: input.userId,
      name: input.name?.trim() ?? '',
      avatar: input.avatar ?? '',
      reason,
      operator: input.operator ?? '',
      duration: input.duration ?? 0,
      place: input.place,
      createdAt: Date.now(),
      messageIds: [],
    })
    const messageIds: string[] = []
    for (const { owner, bot } of targets) {
      try {
        const evidence = evidenceOf(bot, input.evidence)
        if (evidence) messageIds.push(...await bot.sendPrivateMessage(owner.user, evidence))
        messageIds.push(...await bot.sendPrivateMessage(owner.user, requestText(request, input.evidence.length)))
      } catch (error) {
        this.ctx.logger.warn('failed to ask owner %s:%s: %s', owner.platform, owner.user, error instanceof Error ? error.message : String(error))
      }
    }
    if (!messageIds.length) {
      await this.ctx.database.remove('chatluna_blacklist_request', { id: request.id })
      throw new Error('私聊主人失败，无法请示，未拉黑。')
    }
    request.messageIds = messageIds
    await this.ctx.database.set('chatluna_blacklist_request', { id: request.id }, { messageIds })
    this.requests.set(request.id, request)
    this.ctx.logger.info('asked owners to blacklist %s (#%d): %s', keyOf(input.platform, input.userId), request.id, reason)
    return `已就拉黑 ${target} 请示主人（#${request.id}），主人同意前不会拉黑。`
  }

  /**
   * 处理主人私聊里的「同意 / 拒绝 [编号]」，返回回执；不是答复时返回 undefined，消息照常进入对话。
   * 不带编号时先按引用的请示消息对应，否则只在仅有一条待处理请示时默认指它。
   */
  async decide(session: Session) {
    if (!session.isDirect || session.userId === undefined) return
    const setup = this.ctx.get('chatluna_setup')
    if (!setup?.isOwner(session.platform, session.userId)) return
    const text = (session.elements ?? []).filter((element) => element.type === 'text').map((element) => element.attrs['content']).join('').trim()
    const match = DECISION.exec(text)
    if (!match) return
    await this.ready
    const pending = this.pending()
    let request: BlacklistRequest | undefined
    if (match[2]) {
      request = pending.find((item) => item.id === Number(match[2]))
      if (!request) return `拉黑请示 #${match[2]} 不存在、已处理或已过期。`
    } else {
      const quote = session.quote?.id
      request = quote === undefined ? undefined : pending.find((item) => item.messageIds.includes(quote))
      if (!request && pending.length > 1) return `共有 ${pending.length} 条待处理的拉黑请示，答复时须注明编号，如「${match[1]} ${pending[0].id}」。`
      request ??= pending[0]
      if (!request) return
    }
    await this.ctx.database.remove('chatluna_blacklist_request', { id: request.id })
    this.requests.delete(request.id)
    if (match[1] === '拒绝') {
      this.ctx.logger.info('owner rejected blacklist request #%d', request.id)
      return `已驳回拉黑请示 #${request.id}，未拉黑 ${displayOf(request)}。`
    }
    const result = await this.blacklist.add({
      platform: request.platform,
      userId: request.userId,
      name: request.name,
      avatar: request.avatar,
      reason: request.reason,
      operator: keyOf(session.platform, session.userId),
      duration: request.duration,
    })
    return `拉黑请示 #${request.id}：${addedText(result)}`
  }
}

/** 当前会话里该用户最近的消息；没有加载 chat_observer 或会话未知时为空。 */
export function evidenceFrom(ctx: Context, conversationKey: string | undefined, userId: string, limit: number): Evidence[] {
  const observer = ctx.get('chat_observer')
  if (!observer || conversationKey === undefined) return []
  return observer.recent(conversationKey)
    .filter((message) => !message.self && message.userId === userId)
    .slice(-limit)
    .map((message) => ({ userId, name: message.name ?? '', time: message.time, content: message.content }))
}
