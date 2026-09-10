import { useTranslation } from "react-i18next";

import {
  Button,
  DialogShell,
  DialogShellBody,
  DialogShellFooter,
  DialogShellHeader,
  DialogShellSubmit,
} from "@agentre-hub/agentre-ui";

/**
 * 删除一条已保存的对话的确认（规格 2026-08-18 决策 6 / 16）。
 *
 * 删除是**一次**确认，文案要说清楚两边都会被清掉：
 *   - 执行机在线：两份当场一起清掉；
 *   - 执行机离线：账号那份当场清掉，那台机器下次上线时补删——界面上不留
 *     「已删除但还在」这种中间态，所以离线那一版不是把按钮变灰，而是把
 *     「什么时候清掉机器上那份」如实说一句。
 *   - 执行端是**桌面端**时（决策 16 的已知代价）：那台电脑上被清掉的是这条对话
 *     本身，不是一份执行记录——同一个动作在桌面端上的破坏力远大于 agentred，
 *     确认里必须说明这一点。
 *   - 认不出执行端那台机器时（发起端指纹不在设备名单里）：不替它编在线与否，
 *     只说它下次连上时会清掉自己那份。
 */
export interface DeleteSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 执行端那台机器的名字；认不出来时不传。 */
  machineName?: string;
  /** 那台机器此刻在不在线；认不出机器时这一项没有意义。 */
  machineOnline?: boolean;
  /** desktop / agentred。桌面端的删除语义更重，见上面的注释。 */
  machineKind?: string;
  onConfirm: () => void;
  /** 删除请求正在路上：按钮禁用，避免连点发出两次删除。 */
  pending?: boolean;
}

function bodyKey(props: {
  machineName?: string;
  machineOnline?: boolean;
  machineKind?: string;
}): string {
  if (!props.machineName) return "sessionIndex.delete.unknownPeer";
  const desktop = props.machineKind === "desktop";
  if (props.machineOnline) {
    return desktop
      ? "sessionIndex.delete.onlineDesktop"
      : "sessionIndex.delete.online";
  }
  return desktop
    ? "sessionIndex.delete.offlineDesktop"
    : "sessionIndex.delete.offline";
}

export default function DeleteSessionDialog({
  open,
  onOpenChange,
  machineName,
  machineOnline,
  machineKind,
  onConfirm,
  pending = false,
}: DeleteSessionDialogProps) {
  const { t } = useTranslation();
  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      danger
      busy={pending}
    >
      <DialogShellHeader
        title={t("sessionIndex.delete.title")}
        danger
        busy={pending}
      />
      <DialogShellBody>
        <p
          data-testid="delete-session-body"
          className="text-aux leading-relaxed text-muted-foreground"
        >
          {t(bodyKey({ machineName, machineOnline, machineKind }), {
            machine: machineName,
          })}
        </p>
      </DialogShellBody>
      <DialogShellFooter>
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
          {t("chat.cancel")}
        </Button>
        <DialogShellSubmit
          variant="destructive"
          size="sm"
          data-testid="delete-session-confirm"
          busy={pending}
          onClick={onConfirm}
        >
          {t("sessionIndex.delete.confirm")}
        </DialogShellSubmit>
      </DialogShellFooter>
    </DialogShell>
  );
}
