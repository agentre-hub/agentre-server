import {
  Fragment,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@agentre-hub/agentre-ui";
import { CODE_LENGTH, normalize, sanitize } from "@/lib/userCode";

/**
 * 六格设备码输入（画板 06）。
 *
 * 六个真实的 input，不是一个伪装成六格的输入框：屏幕阅读器要能逐位念出
 * 「第几位」，移动端软键盘要能一格一格地退，浏览器的短信验证码自动填充
 * 也只认这种形态。第三与第四格之间那条短横是纯装饰（aria-hidden），
 * 不是可输入格。
 */
export interface CodeInputProps {
  /** 定长 CODE_LENGTH 的受控值，空格用空串。 */
  value: string[];
  onChange: (next: string[]) => void;
  /** 校验失败：整排转 destructive，并给每格挂 aria-invalid。 */
  invalid?: boolean;
  /** 关联到码格组的说明/错误文案 id，空格分隔。 */
  describedBy?: string;
}

export default function CodeInput({
  value,
  onChange,
  invalid = false,
  describedBy,
}: CodeInputProps) {
  const { t } = useTranslation();
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  function focusBox(index: number) {
    const clamped = Math.max(0, Math.min(CODE_LENGTH - 1, index));
    const box = refs.current[clamped];
    box?.focus();
    box?.select();
  }

  /** 从 index 起逐格写入 chars，并把焦点落在写完后的下一格上。 */
  function fill(index: number, chars: string) {
    const next = [...value];
    let i = index;
    for (const c of chars) {
      if (i >= CODE_LENGTH) break;
      next[i++] = c;
    }
    onChange(next);
    focusBox(i);
  }

  function handleChange(index: number, raw: string) {
    // 删空（Delete 键、剪切）：只清本格，不动焦点。
    if (raw === "") {
      const next = [...value];
      next[index] = "";
      onChange(next);
      return;
    }
    const chars = sanitize(raw);
    // 输入的字符全被字母表挡下（0/O/1/I 之类）：不改状态，
    // 受控 input 会把这个字符弹回去，焦点也不前进。
    if (!chars) return;
    // 一次进来多个字符的情况是真实的：浏览器的验证码自动填充会把整串
    // 塞进第一格。按粘贴处理，别只留最后一个字符。
    fill(index, chars);
  }

  function handleKeyDown(index: number, e: KeyboardEvent) {
    if (e.key === "Backspace") {
      // 自己接管而不是交给浏览器默认行为：默认只在本格里删，
      // 于是在空格上连按退格会卡住，用户得手动点回上一格。
      e.preventDefault();
      const next = [...value];
      if (next[index]) {
        next[index] = "";
        onChange(next);
        return;
      }
      if (index > 0) {
        next[index - 1] = "";
        onChange(next);
        focusBox(index - 1);
      }
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusBox(index - 1);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusBox(index + 1);
    }
  }

  function handlePaste(index: number, e: ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    // 整串（含或不含连字符、大小写任意）走严格归一化，一次填满六格；
    // 半截或带杂质的粘贴退回宽松清洗，从当前格往后填。
    const whole = normalize(text);
    if (whole) {
      fill(0, whole.replace("-", ""));
      return;
    }
    const chars = sanitize(text);
    if (chars) fill(index, chars);
  }

  return (
    <div
      role="group"
      aria-label={t("device.entry.groupLabel")}
      aria-describedby={describedBy}
      className="flex items-center justify-center gap-2"
    >
      {value.map((char, i) => (
        <Fragment key={i}>
          {i === CODE_LENGTH / 2 && (
            <span
              aria-hidden="true"
              className={cn(
                "h-0.5 w-3 shrink-0 rounded-full bg-border-strong",
                invalid && "bg-destructive",
              )}
            />
          )}
          <input
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="text"
            inputMode="text"
            // 只有第一格声明 one-time-code：整串自动填充会落进第一格，
            // handleChange 再把它摊到六格里。
            autoComplete={i === 0 ? "one-time-code" : "off"}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={1}
            aria-label={t("device.entry.boxLabel", { position: i + 1 })}
            aria-invalid={invalid || undefined}
            value={char}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={(e) => handlePaste(i, e)}
            onFocus={(e) => e.currentTarget.select()}
            className={cn(
              // 移动端 390 宽下六个 54px 的格子放不下，所以格子等分伸缩、
              // 上限锁在画板的 54px：够宽时就是画板的 54×66 并整排居中，
              // 窄屏自动缩小。min-w-0 是必须的，否则 flex 项不肯缩到内容以下，
              // 整排会顶出横向滚动条。
              "h-14 min-w-0 max-w-[54px] flex-1 rounded-md border border-border bg-card text-center font-mono text-[22px] font-semibold text-foreground outline-none",
              "sm:h-[66px] sm:text-[26px]",
              "focus:border-primary focus:ring-1 focus:ring-primary",
              invalid &&
                "border-destructive bg-destructive-soft text-destructive focus:border-destructive focus:ring-destructive",
            )}
          />
        </Fragment>
      ))}
    </div>
  );
}
