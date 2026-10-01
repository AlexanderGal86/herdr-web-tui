export function terminalFontFamily(fallback: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() ||
    fallback
  );
}
