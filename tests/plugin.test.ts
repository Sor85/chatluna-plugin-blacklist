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
const location = { platform: 'onebot', selfId: '10001', isDirect: false, guild: '30003', channel: '30003' }
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
  const fork = await ctx.plugin(plugin, Config(config))
  await new Promise((resolve) => setTimeout(resolve, 0))

  const call = async (tool: string, args: Record<string, unknown>) => {
    const record = await ctx.tools.execute({ name: tool, args: JSON.parse(JSON.stringify(args)), location, actor })
    return record.ok ? record.value : record.error?.message
  }
  /** 经真实 OneBot 适配器解析的群消息会话。 */
  async function message(userId: string, text: string) {
    const data = {
      time: 1700000000,
      self_id: 10001,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 1,
      group_id: 30003,
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
  return { ctx, bot, fork, sent, call, message, promote }
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
    await app.ctx.plugin(plugin, Config({}))
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
    await app.ctx.plugin(plugin, Config({}))
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
