import { Schema } from '@chatluna/schema'

export interface Config {
  blockCommands: boolean
  approval: boolean
  evidenceCount: number
  /** 只用来在设置页挂载黑名单表格，不保存任何值。 */
  list?: unknown
}

/** 每个字段都写 `extra('label')`，缺 label 时 SchemaForm 会把配置键当标题显示。 */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  blockCommands: Schema.boolean().default(true).extra('label', '屏蔽指令')
    .description('已拉黑用户发送的指令同样不执行；关闭后只屏蔽对话'),
  approval: Schema.boolean().default(true).extra('label', '拉黑前请示主人')
    .description('机器人决定拉黑时，先把对方最近的消息合并转发给主人，主人私聊回复同意后才拉黑；没有可私聊的主人时不拉黑。关闭后直接拉黑'),
  evidenceCount: Schema.natural().min(1).max(100).default(20).extra('label', '罪证条数')
    .description('请示主人时附带该用户在当前会话中最近的消息条数'),
  list: Schema.any().role('blacklist:list').extra('label', '已拉黑用户')
    .description('实时显示当前生效的黑名单，解除拉黑立即生效，无需保存配置'),
})
