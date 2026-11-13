import type { Context } from 'cordis'
import { registerReactFormExtension } from '@chatluna/ui-schema-form/client'
import { BlacklistTable } from './blacklist-table'

export default function apply(ctx: Context) {
  ctx.effect(() => registerReactFormExtension({ role: 'blacklist:list', component: BlacklistTable, priority: 30 }))
}
