import type { ChatImageAttachment } from "@agentre-hub/agentre-ui";

/**
 * 把输入框贴上的图编码成 `runtime.run` 的 `userBlocks`。
 *
 * 这一份**只有一个拼法**是要紧的:两条路都要送图 —— 已有会话那条走
 * `useSessionSend` 的 `startTurn`,第一句话那条走 `lib/dispatch` 的派发 —— 而它们
 * 此前只有前者拼得出来,后者干脆没有这一维,于是草稿里贴的图静默消失。各写一份的话
 * 下一次改块结构就会漏掉其中一条,而漏掉的那条同样不报错。
 *
 * 形状照 Go 侧的 `blocks.StoredBlock`:`{type, data}`,`data` 是 `json.RawMessage`
 * (生成的 TS 类型上是 `unknown`,线上是字节)。载荷这一层的键名归块自己
 * (`media_type` / `source.inline`),不是这条 RPC 的字段,所以是蛇形。
 *
 * 空清单返回 `undefined` 而不是 `[]`:带一个空数组过线等于浏览器在主张「这一轮有
 * 附件、只是一个都没有」,而没贴图本来就是不主张(与 `permissionMode` / 模型键那
 * 几处同一条规矩)。
 */
export function encodeUserBlocks(
  images: readonly ChatImageAttachment[] | undefined,
): { type: string; data: Uint8Array }[] | undefined {
  if (!images?.length) return undefined;
  return images.map((image) => ({
    type: "image",
    data: new TextEncoder().encode(
      JSON.stringify({
        media_type: image.mediaType,
        // dataUrl 是 `data:<mime>;base64,<载荷>`,过线的只要后一半。
        source: { inline: image.dataUrl.split(",", 2)[1] ?? "" },
      }),
    ),
  }));
}
