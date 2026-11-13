import type { Context } from 'cordis'
import type {} from '@chatluna/chat'
import type {} from '@chatluna/tool'
import { Blacklist } from './blacklist'
import { registerCommands } from './commands'
import type { Config } from './config'
import { registerTools } from './tools'
import { registerWebUI } from './webui'

export * from './config'
export type { BlacklistEntry } from './blacklist'

export const name = 'chatluna-blacklist'

/** koishi 与 chatluna_webui 是可选服务：没有 Koishi 兼容层时只屏蔽对话，没有 WebUI 时设置页不显示黑名单。 */
export const inject = ['model', 'database', 'tools', 'permissions']

export function apply(ctx: Context, config: Config) {
  const blacklist = new Blacklist(ctx)
  const blocked = async (session: { platform: string, userId?: string }) => {
    await blacklist.ready
    return blacklist.has(session.platform, session.userId) || undefined
  }
  // before-receive 拦下唤醒与入库；before-open 拦下旁听记录（observer 的 recordUnaddressed）直接派发的消息。
  ctx.on('chat/before-receive', blocked)
  ctx.on('chat/before-open', blocked)
  registerTools(ctx, blacklist)
  ctx.inject(['koishi'], (ctx) => registerCommands(ctx, blacklist, config))
  ctx.inject(['chatluna_webui'], (ctx) => registerWebUI(ctx, blacklist))
}
