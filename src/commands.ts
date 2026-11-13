import type { Context } from 'cordis'
import { Time } from 'cosmokit'
import type {} from 'koishi'
import type {} from '@chatluna/permission'
import { addedText, type Blacklist, displayOf, formatList, keyOf, profileOf } from './blacklist'
import type { Config } from './config'

const owner = 'chatluna-plugin-blacklist'

/** `<user:user>` 参数解析为 `platform:id`。 */
function targetOf(target: string) {
  const split = target.indexOf(':')
  return { platform: target.slice(0, split), userId: target.slice(split + 1) }
}

/** 指令依赖 Koishi 兼容层：屏蔽已拉黑用户的指令，并给管理员提供查看与增删黑名单的指令。 */
export function registerCommands(ctx: Context, blacklist: Blacklist, config: Config) {
  // 指令不经过 chat/before-receive；返回空字符串让指令不执行且不回复。
  if (config.blockCommands) {
    ctx.on('command/before-execute', async ({ session }) => {
      if (session === undefined) return
      await blacklist.ready
      return blacklist.has(session.platform, session.userId) ? '' : undefined
    })
  }

  ctx.command('blacklist', '查看已拉黑用户', { owner, authority: 3 })
    .alias('黑名单')
    .action(async () => {
      await blacklist.ready
      return formatList(blacklist.list())
    })

  ctx.command('blacklist.add <user:user> <reason:text>', '拉黑用户，必须填写理由', { owner, authority: 3 })
    .alias('拉黑')
    .option('time', '-t <time:string> 拉黑时长，如 30m、2h、1d；默认永久')
    .action(async ({ session, options }, target, reason) => {
      if (!session?.userId || !target) return '请指定要拉黑的用户。'
      if (!reason?.trim()) return '请填写拉黑理由。'
      const { platform, userId } = targetOf(target)
      if (platform === session.platform && userId === session.selfId) return '不能拉黑机器人自己。'
      const duration = options?.time === undefined ? undefined : Time.parseTime(options.time)
      if (duration === 0) return '无法识别时长，例如 30m、2h、1d。'
      try {
        const profile = platform === session.platform ? await profileOf(session.bot, userId, session.guildId) : {}
        return addedText(await blacklist.add({ platform, userId, reason, duration, ...profile, operator: keyOf(session.platform, session.userId) }))
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })

  ctx.command('blacklist.remove <user:user>', '解除用户的拉黑', { owner, authority: 3 })
    .alias('解除拉黑')
    .action(async (_, target) => {
      if (!target) return '请指定要解除拉黑的用户。'
      const { platform, userId } = targetOf(target)
      const entry = await blacklist.remove(keyOf(platform, userId))
      return entry ? `已解除 ${displayOf(entry)} 的拉黑。` : `用户 ${userId} 不在黑名单中。`
    })
}
