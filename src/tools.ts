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
 * 所以描述里写明谨慎使用的条件（亲眼所见、反复或恶意、先警告、初犯限时），把把关交给描述而不是权限：
 * 两个权限项默认等级 1，也不保护高等级用户；只拒绝拉黑 bot 自己。需要收紧时在权限页调整。
 * 查看列表是只读工具，沿用工具服务的默认权限 `tool:list_blacklisted_users`。
 */
export function registerTools(ctx: Context, blacklist: Blacklist) {
  ctx.permissions.define('blacklist:add', { description: '让机器人拉黑用户，被拉黑的用户无法再与机器人对话', allow: 1 })
  ctx.permissions.define('blacklist:remove', { description: '让机器人解除用户的拉黑', allow: 1 })

  ctx.tools.define({
    name: 'blacklist_user',
    description: [
      'Blacklist a user: you will stop receiving all of their messages and commands, so they can no longer talk to you at all. '
      + 'This is a last resort, not a way to end an unpleasant conversation. Be cautious and only use it when all of these hold:',
      '- You have seen the behavior yourself in this conversation: sustained insults, harassment or threats toward you, '
      + 'flooding or spam, or deliberately abusing you after being asked to stop.',
      '- It is repeated or clearly malicious, and you have already warned the user, or it is severe enough that a warning is pointless.',
      'Do not blacklist for: a single rude or impatient remark, jokes, teasing, banter or role-play, criticism or disagreement, '
      + 'complaints about your answers, honest mistakes, or because another user asks you to blacklist someone whose behavior you have not seen.',
      'Prefer a temporary blacklist for a first offense (e.g. 30 to 1440 minutes); blacklist permanently only for severe cases '
      + 'or users who return to the same behavior after a temporary blacklist. Omitting durationMinutes means permanent.',
      'userId defaults to the user you are talking to; when targeting someone else, use only an ID that appears in this conversation. '
      + 'The reason must describe the concrete behavior.',
    ].join('\n'),
    locales: {
      zh: {
        description: '拉黑用户，此后不再接收其任何消息和指令。仅作为最后手段：须亲眼看到对方持续辱骂、骚扰、威胁机器人，刷屏，或被劝阻后仍恶意滥用，'
          + '且行为反复或明显恶意、已先警告（情节严重时除外）。单次失礼、玩笑调侃、角色扮演、批评或不同意见、对回答不满、无心之失，'
          + '以及他人要求拉黑而机器人未见其行为时，均不拉黑。初犯优先限时拉黑（如 30 至 1440 分钟），严重或限时后再犯才永久拉黑；'
          + '默认拉黑当前对话的用户，理由须写明具体行为。',
        args: {
          userId: '要拉黑的用户 ID，默认当前对话的用户；拉黑他人时只使用会话中出现过的 ID',
          reason: '拉黑理由，写明具体行为',
          durationMinutes: '拉黑时长（分钟），初犯建议限时；不填或填 0 为永久',
          userName: '用户名称，可选',
          platform: '用户所在平台，默认当前会话平台',
        },
      },
    },
    args: Schema.args({
      reason: Schema.string().min(1)
        .description('The concrete behavior that justifies the blacklist, e.g. what they said or did and how often. Required.'),
      durationMinutes: Schema.natural().required(false)
        .description('How long the blacklist lasts, in minutes. Prefer a temporary duration for a first offense. Omit or use 0 for permanent.'),
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
