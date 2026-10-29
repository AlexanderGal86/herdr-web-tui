import { useState } from "react";
import type { ReactElement } from "react";
import { ActionMenu, ConfirmDialog } from "./overlays";
import type { MachineGroup, MachineGroupView } from "./machines";

export type MachineDisableTarget = { machineId: string; label: string };
export type MachineDisableMenuTarget = MachineDisableTarget & { x: number; y: number };

/**
 * Only saved native SSH machines offer "disable": Local is the bridge host
 * itself, and configured HTTP bridge backends are not machine profiles.
 */
export function machineDisableTarget<T extends MachineGroupView>(
  group: MachineGroup<T>,
): MachineDisableTarget | null {
  if (group.machineId === null || group.view.mode !== "machine") {
    return null;
  }
  return { machineId: group.machineId, label: group.label };
}

/**
 * Context menu + confirmation for disabling one saved SSH machine. Cancel
 * never calls onDisable; while the request is in flight both buttons are
 * locked and a failure keeps the dialog open with the error visible, so the
 * machine is only removed from the tree after the refreshed server list.
 */
export function MachineDisableFlow({
  menu,
  onDisable,
  onCloseMenu,
}: {
  menu: MachineDisableMenuTarget | null;
  onDisable: (machineId: string) => Promise<void>;
  onCloseMenu: () => void;
}): ReactElement {
  const [confirmTarget, setConfirmTarget] = useState<MachineDisableTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disable = (target: MachineDisableTarget) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void onDisable(target.machineId)
      .then(() => setConfirmTarget(null))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      {menu ? (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          title={menu.label}
          items={[{ key: "disable", label: "Отключить подключение", danger: true }]}
          onPick={(key) => {
            if (key !== "disable") return;
            setError(null);
            setConfirmTarget({ machineId: menu.machineId, label: menu.label });
            onCloseMenu();
          }}
          onClose={onCloseMenu}
        />
      ) : null}
      {confirmTarget ? (
        <ConfirmDialog
          title={`Отключить ${confirmTarget.label}?`}
          message={
            `Подключение к «${confirmTarget.label}» будет отключено для всех клиентов этого bridge. ` +
            "Профиль машины сохранится; включить подключение снова можно только нативной командой herdr CLI."
          }
          confirmLabel="Отключить"
          busy={busy}
          error={error ?? undefined}
          onCancel={() => {
            if (!busy) setConfirmTarget(null);
          }}
          onConfirm={() => disable(confirmTarget)}
        />
      ) : null}
    </>
  );
}
