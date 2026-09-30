import { setAppearance, useAppearance } from "./appearance";

export function AppearanceSetting() {
  const appearance = useAppearance();
  return (
    <div className="settings-row">
      <span>Appearance</span>
      <div className="segmented-control" role="group" aria-label="Appearance">
        <button
          type="button"
          data-on={appearance === "tui"}
          aria-pressed={appearance === "tui"}
          onClick={() => setAppearance("tui")}
        >
          Herdr TUI
        </button>
        <button
          type="button"
          data-on={appearance === "web"}
          aria-pressed={appearance === "web"}
          onClick={() => setAppearance("web")}
        >
          Web
        </button>
      </div>
    </div>
  );
}
