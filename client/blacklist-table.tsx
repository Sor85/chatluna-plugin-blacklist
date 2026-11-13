import { useEffect, useState } from 'react'
import { UserRoundXIcon } from 'lucide-react'
import { apiErrorMessage, callAction, toast, useLive } from '@chatluna/ui-client/client'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Spinner,
} from '@chatluna/ui-kit'
import type { SchemaRendererProps } from '@chatluna/ui-schema-form/client'
import type { BlacklistEntry } from '../src/blacklist'

/** 当年的时间省略年份。 */
function timeOf(timestamp: number) {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function remainingOf(ms: number) {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分钟` : `${hours} 小时`
  return hours % 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时` : `${Math.floor(hours / 24)} 天`
}

const displayOf = (entry: BlacklistEntry) => entry.name ? `${entry.name}（${entry.userId}）` : entry.userId

/** 限时拉黑到期时服务端不推送，列表每 30 秒按本地时间刷新剩余时间并隐藏已到期的行。 */
function useNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** 优先用拉黑时存下的头像；onebot 即 QQ，没存时按 QQ 号取头像；都没有时显示名称首字。 */
function avatarOf(entry: BlacklistEntry) {
  if (entry.avatar) return entry.avatar
  if (entry.platform === 'onebot' && /^\d+$/.test(entry.userId)) return `https://q1.qlogo.cn/g?b=qq&nk=${entry.userId}&s=100`
}

/**
 * 设置页里的黑名单列表。它挂在不存值的 `list` 字段上：不调用 onChange，也不用 SchemaForm 的 Field 外壳，
 * 避免出现恢复默认、JSON 编辑等只对配置值有意义的菜单。用逐项卡片而非表格：理由长短不一，固定列宽会把它挤成窄条。
 */
export function BlacklistTable(props: SchemaRendererProps) {
  const list = useLive('blacklist.list')
  const now = useNow()
  const [removing, setRemoving] = useState<BlacklistEntry>()
  const entries = (list.data ?? []).filter((entry) => entry.expiresAt === 0 || entry.expiresAt > now).reverse()
  const label = String(props.schema.meta.label ?? props.path)
  const description = props.schema.meta.description

  const placeholder = list.status === 'loading' && list.data === undefined
    ? <span className="inline-flex items-center gap-2"><Spinner />正在加载</span>
    : list.status === 'offline' && list.data === undefined ? '无法连接服务器' : '暂无已拉黑用户'

  return (
    <div className="min-w-0 space-y-3 text-sm leading-5" data-blacklist-list="">
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-base font-semibold leading-6">
          {label}
          {entries.length > 0 && <Badge variant="secondary">{entries.length}</Badge>}
        </div>
        {typeof description === 'string' && <p className="text-muted-foreground">{description}</p>}
      </div>
      {entries.length === 0
        ? <div className="flex h-16 items-center justify-center rounded-lg border border-dashed text-muted-foreground">{placeholder}</div>
        : (
          <ItemGroup aria-label={label} className="gap-2">
            {entries.map((entry) => {
              const name = entry.name || entry.userId
              return (
                <Item key={entry.id} role="listitem" variant="outline" className="flex-nowrap items-start gap-3">
                  <ItemMedia>
                    <Avatar size="lg">
                      <AvatarImage src={avatarOf(entry)} alt="" referrerPolicy="no-referrer" />
                      <AvatarFallback>{Array.from(name)[0]}</AvatarFallback>
                    </Avatar>
                  </ItemMedia>
                  <ItemContent className="min-w-0 gap-1">
                    <ItemTitle className="w-full min-w-0 flex-wrap gap-x-2 gap-y-0.5">
                      <span className="truncate">{name}</span>
                      <span className="text-xs font-normal leading-4 text-muted-foreground">
                        {entry.name ? `${entry.userId} · ` : ''}{entry.platform}
                      </span>
                    </ItemTitle>
                    <p className="whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere]">{entry.reason}</p>
                    <p className="text-xs leading-4 text-muted-foreground tabular-nums">
                      {timeOf(entry.createdAt)} 拉黑{entry.expiresAt === 0 ? '' : `，${timeOf(entry.expiresAt)} 到期`}
                    </p>
                  </ItemContent>
                  <ItemActions className="shrink-0 gap-1">
                    {entry.expiresAt === 0
                      ? <Badge variant="destructive">永久</Badge>
                      : <Badge variant="outline" className="tabular-nums">剩 {remainingOf(entry.expiresAt - now)}</Badge>}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`解除拉黑：${displayOf(entry)}`}
                      title="解除拉黑"
                      onClick={() => setRemoving(entry)}
                    >
                      <UserRoundXIcon />
                    </Button>
                  </ItemActions>
                </Item>
              )
            })}
          </ItemGroup>
        )}
      <RemoveDialog entry={removing} onClose={() => setRemoving(undefined)} />
    </div>
  )
}

function RemoveDialog({ entry, onClose }: { entry: BlacklistEntry | undefined, onClose(): void }) {
  const [pending, setPending] = useState(false)
  const confirm = async () => {
    if (!entry) return
    setPending(true)
    try {
      await callAction('blacklist.remove', { id: entry.id })
      toast.success(`已解除 ${displayOf(entry)} 的拉黑`)
      onClose()
    } catch (error) {
      toast.error(apiErrorMessage(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <AlertDialog open={entry !== undefined} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>解除拉黑</AlertDialogTitle>
          <AlertDialogDescription>
            解除后 {entry ? displayOf(entry) : ''} 可再次与机器人对话，拉黑理由一并删除。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
            {pending && <Spinner />}
            解除拉黑
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
