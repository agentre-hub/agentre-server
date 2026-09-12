import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import {
  ProjectCreateDialog,
  ProjectDeleteDialog,
  ProjectSettingsDialog,
  type ProjectCreatePorts,
  type ProjectDeletePorts,
  type ProjectSettingsPorts,
  type ProjectSettingsView,
} from "@agentre-hub/agentre-ui";
// 图标清单在共享包里（项目的 icon 与部门 / Agent 的 avatar_icon 存的是同一串
// key）；本站留的是这个选择器的渲染，所以包收的是画好的东西。

/** 父项目下拉的一个候选。 */
interface ParentOption {
  id: string;
  name: string;
}

export interface ProjectCreateDialogState {
  /** `false` = 不开；`null` = 建顶层项目；给了项目 = 建它的子项目。 */
  parent: { syncId: string; name: string } | null | false;
  parentOptions: ParentOption[];
  ports: ProjectCreatePorts;
  close: () => void;
  onCreated: () => void;
}

export interface ProjectSettingsDialogState {
  project: ProjectSettingsView | null;
  parentOptions: ParentOption[];
  focus?: "members" | "paths";
  ports: ProjectSettingsPorts;
  close: () => void;
  onChanged: () => void;
}

export interface ProjectDeleteDialogState {
  project: { id: string; name: string } | null;
  childCount: number;
  offlineMachines: string[];
  ports: ProjectDeletePorts;
  close: () => void;
  onDeleted: () => void;
}

/**
 * 页面把这一份整个交过来、自己不拆开：三个弹窗各要什么，是它们与
 * `useProjectManagement` 之间的事，「对话」页只负责把这一族挂上。
 */
export interface ProjectDialogsProps {
  create: ProjectCreateDialogState;
  settings: ProjectSettingsDialogState;
  deletion: ProjectDeleteDialogState;
}

/** 项目管理的三个弹窗（规格 2026-08-20）。入口全在项目组头上。 */
export function ProjectDialogs({
  create,
  settings,
  deletion,
}: ProjectDialogsProps) {
  const { t } = useTranslation();

  return (
    <>
      {create.parent !== false && (
        <ProjectCreateDialog
          open
          onOpenChange={(open) => {
            if (!open) create.close();
          }}
          parentOptions={create.parentOptions}
          initialParentId={create.parent?.syncId}
          parentName={create.parent?.name}
          ports={create.ports}
          onCreated={() => create.onCreated()}
        />
      )}

      {settings.project && (
        <ProjectSettingsDialog
          open
          onOpenChange={(open) => {
            if (!open) settings.close();
          }}
          project={settings.project}
          parentOptions={settings.parentOptions}
          ports={settings.ports}
          focus={settings.focus}
          devicesLink={
            <Link to="/devices" className="text-primary-text hover:underline">
              {t("project.settings.pathsGoDevices")}
            </Link>
          }
          onChanged={settings.onChanged}
        />
      )}

      {deletion.project && (
        <ProjectDeleteDialog
          open
          onOpenChange={(open) => {
            if (!open) deletion.close();
          }}
          project={deletion.project}
          childCount={deletion.childCount}
          offlineMachines={deletion.offlineMachines}
          ports={deletion.ports}
          onDeleted={() => deletion.onDeleted()}
        />
      )}
    </>
  );
}
