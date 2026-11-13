import type { Context } from 'cordis'
import { Schema } from '@chatluna/schema'
import type {} from '@chatluna/ui-server'
import type { Blacklist, BlacklistEntry } from './blacklist'

declare module '@chatluna/ui-client/client' {
  interface States {
    'blacklist.list': BlacklistEntry[]
  }
  interface Actions {
    'blacklist.remove'(input: { id: string }): void
  }
}

/** 设置页的黑名单表格：列表随 `blacklist/change` 推送，解除拉黑直接改数据库，不经过插件配置。 */
export function registerWebUI(ctx: Context, blacklist: Blacklist) {
  const webui = ctx.chatluna_webui
  webui.addEntry({ baseUrl: import.meta.url, source: '../client/index.ts', bundle: '../dist/client.js' })
  webui.state('blacklist.list', { get: () => blacklist.list(), refreshOn: ['blacklist/change'] })
  webui.action('blacklist.remove', { input: Schema.object({ id: Schema.string().required() }) }, async ({ id }) => {
    await blacklist.remove(id)
  })
}
