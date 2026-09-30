export function spaceScrollContainer(list: HTMLElement | null): HTMLElement | null {
  const section = list?.querySelector<HTMLElement>('[data-sidebar-section="spaces"]');
  if (section && ["auto", "scroll"].includes(getComputedStyle(section).overflowY)) {
    return section;
  }
  return list;
}
