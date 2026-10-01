// WHY: must be imported after "./styles.css" (see main.tsx) —
// herdr-tui.css overrides the base stylesheet, import order
// decides which CSS wins.
import "./herdr-tui.css";
import { initializeAppearance } from "./appearance";

initializeAppearance();
