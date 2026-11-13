import { Schema } from '@chatluna/schema'

export interface Config {
  blockCommands: boolean
  /** 只用来在设置页挂载黑名单表格，不保存任何值。 */
  list?: unknown
}

/** 每个字段都写 `extra('label')`，缺 label 时 SchemaForm 会把配置键当标题显示。 */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  blockCommands: Schema.boolean().default(true).extra('label', '屏蔽指令')
    .description('已拉黑用户发送的指令同样不执行；关闭后只屏蔽对话'),
  list: Schema.any().role('blacklist:list').extra('label', '已拉黑用户')
    .description('实时显示当前生效的黑名单，解除拉黑立即生效，无需保存配置'),
})
