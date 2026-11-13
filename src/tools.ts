import type { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import { Time } from 'cosmokit'
import type { ToolCallContext } from '@chatluna/tool'
import type {} from '@chatluna/permission'
import type {} from '@satorijs/core'
import { addedText, type Blacklist, displayOf, formatList, keyOf, profileOf } from './blacklist'

const platformArg = () => Schema.string().required(false)
  .description('Platform of the user. Defaults to the platform of the current conversation.')

function platformOf(call: ToolCallContext, platform: string | undefined) {
  const resolved = platform?.trim() || call.location?.platform
  if (!resolved) throw new Error('platform is required outside a conversation.')
  return resolved
}

/**
 * 拉黑工具给 bot 自己用：用户辱骂、骚扰 bot 时由模型判断后拉黑对方，调用者通常就是被拉黑的人，
 * 所以两个权限项默认等级 1，也不保护高等级用户；只拒绝拉黑 bot 自己。需要收紧时在权限页调整。
 * 查看列表是只读工具，沿用工具服务的默认权限 `tool:list_blacklisted_users`。
 */
export function registerTools(ctx: Context, blacklist: Blacklist) {
  ctx.permissions.define('blacklist:add', { description: '让机器人拉黑用户，被拉黑的用户无法再与机器人对话', allow: 1 })
  ctx.permissions.define('blacklist:remove', { description: '让机器人解除用户的拉黑', allow: 1 })

  ctx.tools.define({
    name: 'blacklist_user',
    description: 'Blacklist a user so you never receive their messages or commands again. Use it on your own judgement when a user '
      + 'insults, harasses or abuses you, or keeps spamming after being asked to stop. userId defaults to the user you are '
      + 'talking to. A reason is required. Set durationMinutes for a temporary blacklist; omit it to blacklist permanently.',
    locales: {
      zh: {
        description: '拉黑用户，此后不再接收其消息和指令。用户辱骂、骚扰机器人或屡劝不止地刷屏时，由机器人自行判断调用；默认拉黑当前对话的用户，必须填写理由，可设置拉黑时长，不设置为永久。',
        args: {
          userId: '要拉黑的用户 ID，默认当前对话的用户',
          reason: '拉黑理由',
          durationMinutes: '拉黑时长（分钟），不填或填 0 为永久',
          userName: '用户名称，可选',
          platform: '用户所在平台，默认当前会话平台',
        },
      },
    },
    args: Schema.args({
      reason: Schema.string().min(1).description('Why this user is blacklisted, e.g. what they said. Required.'),
      durationMinutes: Schema.natural().required(false)
        .description('How long the blacklist lasts, in minutes. Omit or use 0 to blacklist permanently.'),
      userId: Schema.string().required(false).description('ID of the user to blacklist. Defaults to the user you are talking to.'),
      userName: Schema.string().required(false).description('Display name of the user, if known.'),
      platform: platformArg(),
    }),
    traits: { effect: 'write' },
    permission: 'blacklist:add',
    async run(args: { reason: string, durationMinutes?: number, userId?: string, userName?: string, platform?: string }, call) {
      const platform = platformOf(call, args.platform)
      const actor = call.actor
      const userId = args.userId?.trim() || actor?.user
      if (!userId) throw new Error('userId is required: there is no current speaker.')
      const location = call.location
      const here = platform === location?.platform
      if (here && userId === location.selfId) throw new Error('不能拉黑机器人自己。')
      const bot = here ? ctx.get('satori')?.bots.find((bot) => bot.platform === platform && bot.selfId === location.selfId) : undefined
      const profile = await profileOf(bot, userId, here && !location.isDirect ? location.guild : undefined)
      return addedText(await blacklist.add({
        platform,
        userId,
        name: args.userName || profile.name,
        avatar: profile.avatar,
        reason: args.reason,
        operator: actor?.user === undefined ? undefined : keyOf(actor.platform ?? platform, actor.user),
        duration: (args.durationMinutes ?? 0) * Time.minute,
      }))
    },
  })

  ctx.tools.define({
    name: 'unblacklist_user',
    description: 'Remove a user from the blacklist so they can talk to you again.',
    locales: {
      zh: {
        description: '解除用户的拉黑，恢复其与机器人对话。',
        args: { userId: '要解除拉黑的用户 ID', platform: '用户所在平台，默认当前会话平台' },
      },
    },
    args: Schema.args({
      userId: Schema.string().min(1).description('ID of the user to remove from the blacklist.'),
      platform: platformArg(),
    }),
    traits: { effect: 'write' },
    permission: 'blacklist:remove',
    async run(args: { userId: string, platform?: string }, call) {
      const platform = platformOf(call, args.platform)
      const userId = args.userId.trim()
      if (!userId) throw new Error('userId is required.')
      const entry = await blacklist.remove(keyOf(platform, userId))
      return entry ? `已解除 ${displayOf(entry)} 的拉黑。` : `用户 ${userId} 不在黑名单中。`
    },
  })

  ctx.tools.define({
    name: 'list_blacklisted_users',
    description: 'List blacklisted users with their reasons and when they were blacklisted.',
    locales: {
      zh: {
        description: '列出已拉黑的用户及其理由和拉黑时间。',
        args: { platform: '只列出该平台的用户，默认列出全部平台' },
      },
    },
    args: Schema.args({
      platform: Schema.string().required(false).description('Only list users on this platform. Defaults to all platforms.'),
    }),
    traits: { effect: 'read' },
    async run(args: { platform?: string }) {
      await blacklist.ready
      return formatList(blacklist.list(args.platform?.trim() || undefined))
    },
  })
}
