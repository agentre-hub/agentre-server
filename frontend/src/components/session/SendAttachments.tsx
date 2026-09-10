import type { ChatImageAttachment } from "@agentre-hub/agentre-ui";

/**
 * 一条**还没发出去**的消息带着的图（排队那条与失败那条共用）。
 *
 * 两处都要摆是要紧的:这两条气泡的全部意义就是「用户刚写的东西留在屏幕上」
 * （决策 6 / 决策 7）。只留文本的话,贴了图的那条在屏幕上看着是一条纯文本消息——
 * 用户按下「重发」时以为发的是自己刚写的那条,而屏幕从来没说过图还在不在。
 *
 * 与转录里一条真用户消息的图同形（共享包 `ImageBlockView`）:点得开、原图另开一页。
 * 尺寸压得比转录里那份小,因为这两条是「待处理」而不是「已发生」——它们随时会被
 * 撤掉或重发,不该像一条真消息那样占满一屏。
 */
export default function SendAttachments({
  images,
}: {
  images?: readonly ChatImageAttachment[];
}) {
  if (!images?.length) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {images.map((image, index) => (
        <a
          key={`${image.name}-${index}`}
          href={image.dataUrl}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-md border border-border bg-muted"
        >
          <img
            src={image.dataUrl}
            // 名字是用户自己文件的名字,动态内容,不进 t(...)。名字缺席时退到
            // MIME:比一句编出来的「图片」更说得出这是什么。
            alt={image.name || image.mediaType}
            className="h-16 w-20 object-cover"
          />
        </a>
      ))}
    </div>
  );
}
