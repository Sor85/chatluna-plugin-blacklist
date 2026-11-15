import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { h, type Session } from '@satorijs/core'
import Database from '@cordisjs/plugin-database'
import Sqlite from '@cordisjs/plugin-database-sqlite'
import Permission from '@chatluna/permission'
import Tool from '@chatluna/tool'
import Koishi from 'koishi'
import { OneBot, OneBotBot } from 'koishi-plugin-adapter-onebot'
import { apply, Config, inject, name } from '../src'

const plugin = { apply, Config, inject, name }
const roots: Context[] = []
const location = { platform: 'onebot', selfId: '10001', isDirect: false, guild: '30003', channel: '30003', session: 'onebot:30003' }
const actor = { ...location, user: '20002' }

async function host(config: Partial<Config> = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(Database)
  await ctx.plugin(Sqlite, { path: ':memory:' })
  await ctx.plugin(Permission, {})
  await ctx.plugin(Tool, {})
  await ctx.plugin(Koishi, { prefix: ['/'] })
  // 没有挂载 HTTP 服务，真实适配器不会连接。
  const bot = new OneBotBot(ctx, { protocol: 'http', selfId: '10001', advanced: { splitMixedContent: false } })
  const sent: string[] = []
  vi.spyOn(bot, 'sendMessage').mockImplementation(async (_channelId, content) => {
    sent.push(h.normalize(content).join(''))
    return [String(sent.length)]
  })
  const privates: { userId: string, content: string }[] = []
  vi.spyOn(bot, 'sendPrivateMessage').mockImplementation(async (userId, content) => {
    privates.push({ userId, content: h.normalize(content).join('') })
    return [`p${privates.length}`]
  })
  // 已有用例测试直接拉黑，请示主人的用例显式开启。
  const fork = await ctx.plugin(plugin, Config({ approval: false, ...config }))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const call = async (tool: string, args: Record<string, unknown>) => {
    const record = await ctx.tools.execute({ name: tool, args: JSON.parse(JSON.stringify(args)), location, actor })
    return record.ok ? record.value : record.error?.message
  }
  /** 经真实 OneBot 适配器解析的群消息会话，`direct` 为私聊。 */
  async function message(userId: string, text: string, direct = false) {
    const data = {
      time: 1700000000,
      self_id: 10001,
      post_type: 'message',
      message_type: direct ? 'private' : 'group',
      sub_type: direct ? 'friend' : 'normal',
      message_id: 1,
      ...direct ? {} : { group_id: 30003 },
      user_id: Number(userId),
      message: text,
      raw_message: text,
      font: 0,
      sender: { user_id: Number(userId), nickname: `user${userId}`, role: 'member' },
    }
    const session: Session = await Reflect.apply(OneBot.adaptSession, undefined, [bot, data])
    return session
  }
  const promote = (user: string, level: number) => ctx.permissions.save({
    id: `test-${user}`,
    permission: `authority:${level}`,
    effect: 'allow',
    when: { kind: 'and', operands: [
      { kind: 'scope', field: 'platform', values: ['onebot'] },
      { kind: 'scope', field: 'user', values: [user] },
    ] },
  })
  return { ctx, bot, fork, sent, privates, call, message, promote }
}

afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

describe('工具', () => {
  it('拉黑、查看列表、解除拉黑', async () => {
    const app = await host()
    expect(await app.call('list_blacklisted_users', {})).toBe('黑名单为空。')
    expect(await app.call('blacklist_user', { userId: '40004', userName: '小明', reason: '刷屏' })).toBe('已拉黑 小明（40004），期限：永久，理由：刷屏')
    const list = await app.call('list_blacklisted_users', {})
    expect(list).toContain('共 1 名已拉黑用户')
    expect(list).toContain('1. 小明（40004），平台：onebot，理由：刷屏')
    expect(list).toContain('期限：永久')
    expect(await app.call('blacklist_user', { userId: '40004', reason: '别的理由' })).toBe('小明（40004） 已在黑名单中，期限：永久，原理由：刷屏')
    expect(await app.call('unblacklist_user', { userId: '40004' })).toBe('已解除 小明（40004） 的拉黑。')
    expect(await app.call('unblacklist_user', { userId: '40004' })).toBe('用户 40004 不在黑名单中。')
    expect(await app.call('list_blacklisted_users', {})).toBe('黑名单为空。')
  })

  it('记下群名片与头像，查询失败时留空', async () => {
    const app = await host()
    vi.spyOn(app.bot, 'getGuildMember').mockResolvedValueOnce({ nick: '群名片', user: { id: '40004', avatar: 'http://avatar/40004.png' } })
    expect(await app.call('blacklist_user', { userId: '40004', reason: '辱骂' })).toContain('已拉黑 群名片（40004）')
    vi.spyOn(app.bot, 'getGuildMember').mockRejectedValueOnce(new Error('offline'))
    vi.spyOn(app.bot, 'getUser').mockRejectedValueOnce(new Error('offline'))
    expect(await app.call('blacklist_user', { userId: '40005', reason: '刷屏' })).toContain('已拉黑 40005')
    expect(await app.ctx.database.get('chatluna_blacklist', {})).toMatchObject([
      { id: 'onebot:40004', name: '群名片', avatar: 'http://avatar/40004.png' },
      { id: 'onebot:40005', name: '', avatar: '' },
    ])
  })

  it('理由为空时拒绝拉黑', async () => {
    const app = await host()
    expect(await app.call('blacklist_user', { userId: '40004', reason: '   ' })).toContain('拉黑必须填写理由')
    expect(await app.call('blacklist_user', { userId: '40004' })).not.toContain('已拉黑')
    expect(await app.call('list_blacklisted_users', {})).toBe('黑名单为空。')
  })

  it('不填 userId 时拉黑当前对话的用户', async () => {
    const app = await host()
    expect(await app.call('blacklist_user', { reason: '辱骂机器人' })).toBe('已拉黑 20002，期限：永久，理由：辱骂机器人')
    expect(await app.call('list_blacklisted_users', {})).toContain('1. 20002，平台：onebot，理由：辱骂机器人')
  })

  it('不保护高等级用户，只拒绝拉黑机器人自己', async () => {
    const app = await host()
    expect(await app.call('blacklist_user', { userId: '10001', reason: '测试' })).toContain('不能拉黑机器人自己')
    await app.promote('50005', 5)
    expect(await app.call('blacklist_user', { userId: '50005', reason: '辱骂机器人' })).toBe('已拉黑 50005，期限：永久，理由：辱骂机器人')
  })

  it('记录发起人并在插件重载后从数据库恢复', async () => {
    const app = await host()
    await app.call('blacklist_user', { userId: '40004', reason: '辱骂' })
    const rows = await app.ctx.database.get('chatluna_blacklist', {})
    expect(rows).toMatchObject([{ id: 'onebot:40004', reason: '辱骂', operator: 'onebot:20002', name: '' }])
    await app.fork.dispose()
    await app.ctx.plugin(plugin, Config({ approval: false }))
    expect(await app.call('list_blacklisted_users', {})).toContain('1. 40004，平台：onebot，理由：辱骂')
  })
})

describe('设置页列表', () => {
  it('增删时触发 blacklist/change，供 WebUI 推送列表', async () => {
    const app = await host()
    const changes = vi.fn()
    app.ctx.on('blacklist/change', changes)
    await app.call('blacklist_user', { userId: '40004', reason: '刷屏' })
    await app.call('blacklist_user', { userId: '40004', reason: '重复' })
    await app.call('unblacklist_user', { userId: '40004' })
    expect(changes).toHaveBeenCalledTimes(2)
  })
})

describe('拉黑时长', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('到期后自动失效，可重新拉黑，重载时删除到期记录', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-13T12:00:00+08:00'))
    const app = await host()
    expect(await app.call('blacklist_user', { userId: '40004', reason: '辱骂', durationMinutes: 30 })).toMatch(/^已拉黑 40004，期限：至 2026\/11\/13 12:30:00，理由：辱骂$/)
    const session = await app.message('40004', 'hello')
    expect(await app.ctx.serial('chat/before-receive', session)).toBe(true)

    vi.setSystemTime(new Date('2026-11-13T12:31:00+08:00'))
    expect(await app.ctx.serial('chat/before-receive', session)).toBeUndefined()
    expect(await app.call('list_blacklisted_users', {})).toBe('黑名单为空。')
    expect(await app.call('blacklist_user', { userId: '40004', reason: '再次辱骂', durationMinutes: 0 })).toBe('已拉黑 40004，期限：永久，理由：再次辱骂')
    expect(await app.call('blacklist_user', { userId: '40005', reason: '刷屏', durationMinutes: 10 })).toContain('期限：至 2026/11/13 12:41:00')

    vi.setSystemTime(new Date('2026-11-13T13:00:00+08:00'))
    await app.fork.dispose()
    await app.ctx.plugin(plugin, Config({ approval: false }))
    expect(await app.call('list_blacklisted_users', {})).toContain('共 1 名已拉黑用户')
    expect(await app.ctx.database.get('chatluna_blacklist', {})).toMatchObject([{ id: 'onebot:40004', expiresAt: 0 }])
  })
})

describe('拦截', () => {
  it('已拉黑用户的消息不进入对话，其他用户不受影响', async () => {
    const app = await host()
    await app.call('blacklist_user', { userId: '40004', reason: '刷屏' })
    const blocked = await app.message('40004', 'hello')
    const normal = await app.message('20002', 'hello')
    expect(await app.ctx.serial('chat/before-receive', blocked)).toBe(true)
    expect(await app.ctx.serial('chat/before-open', blocked)).toBe(true)
    expect(await app.ctx.serial('chat/before-receive', normal)).toBeUndefined()
    await app.call('unblacklist_user', { userId: '40004' })
    expect(await app.ctx.serial('chat/before-receive', blocked)).toBeUndefined()
  })

  it('屏蔽已拉黑用户的指令，关闭后放行', async () => {
    const app = await host()
    app.ctx.command('ping').action(() => 'pong')
    await app.call('blacklist_user', { userId: '40004', reason: '刷屏' })
    await (await app.message('40004', '/ping')).execute('ping')
    await (await app.message('20002', '/ping')).execute('ping')
    expect(app.sent).toEqual(['pong'])

    const open = await host({ blockCommands: false })
    open.ctx.command('ping').action(() => 'pong')
    await open.call('blacklist_user', { userId: '40004', reason: '刷屏' })
    await (await open.message('40004', '/ping')).execute('ping')
    expect(open.sent).toEqual(['pong'])
  })
})

describe('管理指令', () => {
  it('管理员可查看、拉黑和解除拉黑，拉黑必须带理由', async () => {
    const app = await host()
    await app.promote('20002', 4)
    const run = async (command: string) => {
      await (await app.message('20002', command)).execute(command)
      return app.sent.at(-1)
    }
    expect(await run('blacklist')).toBe('黑名单为空。')
    expect(await run('blacklist.add @40004')).toContain('理由')
    expect(await run('blacklist.add -t 2h @40004 刷屏 广告')).toContain('已拉黑 40004，期限：至 ')
    expect(app.sent.at(-1)).toContain('理由：刷屏 广告')
    expect(await run('blacklist')).toContain('1. 40004，平台：onebot，理由：刷屏 广告')
    expect(await run('blacklist.remove <at id="40004"/>')).toBe('已解除 40004 的拉黑。')
  })

  it('普通用户不能使用管理指令', async () => {
    const app = await host()
    await (await app.message('20002', 'blacklist')).execute('blacklist')
    expect(app.sent.join('')).not.toContain('黑名单为空')
  })
})

describe('请示主人', () => {
  const owner = '90009'
  const observed = (userId: string, text: string, time: number) => ({ userId, name: `user${userId}`, time, self: false, content: [{ type: 'text', text }] })

  async function approval() {
    const app = await host({ approval: true })
    app.bot.user = { id: '10001', name: '宁宁' }
    app.ctx.provide('chatluna_setup', {
      snapshot: () => ({ owners: [{ platform: 'onebot', user: owner }, { platform: 'web', user: 'admin' }] }),
      isOwner: (platform: string, user: string) => platform === 'onebot' && user === owner,
    })
    const recent = vi.fn(() => [
      { ...observed('20002', '傻瓜机器人', 1), content: [{ type: 'text', text: '@self 傻瓜机器人 @selfish' }] },
      observed('40004', '路过', 2),
      { ...observed('10001', '请文明发言', 3), self: true },
      observed('20002', '就骂你', 4),
    ])
    app.ctx.provide('chat_observer', { recent })
    /** 主人私聊一条消息，返回 before-receive 的结果和机器人的回执。 */
    const reply = async (text: string, quote?: string, userId = owner) => {
      const session = await app.message(userId, text, true)
      if (quote) session.quote = { id: quote }
      const before = app.sent.length
      const result = await app.ctx.serial('chat/before-receive', session)
      return { result, receipt: app.sent.slice(before).join('') }
    }
    return { ...app, recent, reply }
  }

  it('合并转发罪证给主人，主人同意后才拉黑', async () => {
    const app = await approval()
    const result = await app.call('blacklist_user', { reason: '持续辱骂', durationMinutes: 30 })
    expect(result).toBe('已就拉黑 20002 请示主人（#1），主人同意前不会拉黑。')
    expect(app.recent).toHaveBeenCalledWith('onebot:30003')
    expect(app.privates.map((item) => item.userId)).toEqual([owner, owner])
    const [forward, request] = app.privates.map((item) => item.content)
    expect(forward).toMatch(/^<message forward>/)
    expect(forward).toContain('<author id="20002" name="user20002"/>@宁宁 傻瓜机器人 @selfish')
    expect(forward).toContain('就骂你')
    expect(forward).not.toContain('路过')
    expect(forward).not.toContain('请文明发言')
    expect(request).toContain('拉黑请示 #1')
    expect(request).toContain('群 30003')
    expect(request).toContain('时长：30 分钟')
    expect(request).toContain('理由：持续辱骂')
    expect(request).toContain('上方合并转发的 2 条消息')
    expect(await app.call('list_blacklisted_users', {})).toBe('黑名单为空。')

    expect(await app.call('blacklist_user', { reason: '再次辱骂' })).toBe('已就拉黑 20002 请示过主人（#1），尚未答复，主人同意前不会拉黑。')
    expect(app.privates).toHaveLength(2)

    const { result: handled, receipt } = await app.reply('同意')
    expect(handled).toBe(true)
    expect(receipt).toMatch(/^拉黑请示 #1：已拉黑 20002，期限：至 .+，理由：持续辱骂$/)
    expect(await app.ctx.database.get('chatluna_blacklist', {})).toMatchObject([{ id: 'onebot:20002', operator: `onebot:${owner}` }])
    expect(await app.ctx.database.get('chatluna_blacklist_request', {})).toEqual([])
    expect((await app.reply('同意 1')).receipt).toBe('拉黑请示 #1 不存在、已处理或已过期。')
  })

  it('拒绝时不拉黑；多条请示须注明编号或引用请示消息', async () => {
    const app = await approval()
    await app.call('blacklist_user', { reason: '刷屏' })
    await app.call('blacklist_user', { userId: '40004', reason: '骚扰' })
    expect((await app.reply('拒绝')).receipt).toBe('共有 2 条待处理的拉黑请示，答复时须注明编号，如「拒绝 1」。')
    expect((await app.reply('拒绝 2')).receipt).toBe('已驳回拉黑请示 #2，未拉黑 40004。')
    await app.call('blacklist_user', { userId: '40004', reason: '骚扰' })
    expect((await app.reply('同意', 'p6')).receipt).toContain('拉黑请示 #3：已拉黑 40004')
    expect(await app.call('list_blacklisted_users', {})).toContain('共 1 名已拉黑用户')
    expect((await app.reply('拒绝')).receipt).toBe('已驳回拉黑请示 #1，未拉黑 20002。')
  })

  it('非主人、群聊和普通私聊照常进入对话', async () => {
    const app = await approval()
    await app.call('blacklist_user', { reason: '刷屏' })
    expect((await app.reply('同意', undefined, '20002')).result).toBeUndefined()
    const group = await app.message(owner, '同意')
    expect(await app.ctx.serial('chat/before-receive', group)).toBeUndefined()
    expect((await app.reply('你好')).result).toBeUndefined()
    expect(await app.call('list_blacklisted_users', {})).toBe('黑名单为空。')
  })

  it('没有可私聊的主人或私聊失败时不拉黑', async () => {
    const app = await approval()
    app.ctx.set('chatluna_setup', { snapshot: () => ({ owners: [{ platform: 'web', user: 'admin' }] }), isOwner: () => false })
    expect(await app.call('blacklist_user', { reason: '刷屏' })).toContain('没有可私聊的主人')
    app.ctx.set('chatluna_setup', { snapshot: () => ({ owners: [{ platform: 'onebot', user: owner }] }), isOwner: () => true })
    vi.mocked(app.bot.sendPrivateMessage).mockRejectedValue(new Error('offline'))
    expect(await app.call('blacklist_user', { reason: '刷屏' })).toContain('私聊主人失败')
    expect(await app.ctx.database.get('chatluna_blacklist_request', {})).toEqual([])
    expect(await app.call('list_blacklisted_users', {})).toBe('黑名单为空。')
  })

  it('请示在重载后保留，24 小时后作废', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-13T12:00:00+08:00'))
    const app = await approval()
    await app.call('blacklist_user', { reason: '刷屏' })
    await app.fork.dispose()
    await app.ctx.plugin(plugin, Config({}))
    expect((await app.reply('拒绝')).receipt).toBe('已驳回拉黑请示 #1，未拉黑 20002。')

    await app.call('blacklist_user', { reason: '刷屏' })
    vi.setSystemTime(new Date('2026-11-14T12:00:01+08:00'))
    expect((await app.reply('同意')).result).toBeUndefined()
    expect(await app.call('blacklist_user', { reason: '刷屏' })).toBe('已就拉黑 20002 请示主人（#3），主人同意前不会拉黑。')
    vi.useRealTimers()
  })
})
