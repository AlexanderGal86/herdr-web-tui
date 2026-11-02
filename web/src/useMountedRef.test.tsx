/**
 * @vitest-environment jsdom
 */
import { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useMountedRef } from "./App";

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
});

function renderProbe() {
  // Closure writes defeat control-flow narrowing; collect refs instead.
  const observed: { current: boolean }[] = [];
  function Probe() {
    observed.push(useMountedRef());
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const last = () => observed[observed.length - 1];
  return { render: (node: boolean) => act(async () => { root.render(node ? <StrictMode><Probe /></StrictMode> : null); }), last };
}

describe("useMountedRef", () => {
  it("stays true across StrictMode double-mounts", async () => {
    const probe = renderProbe();
    await probe.render(true);
    expect(probe.last()).toBeDefined();
    expect(probe.last().current).toBe(true);
  });

  it("flips to false only after real unmount", async () => {
    const probe = renderProbe();
    await probe.render(true);
    expect(probe.last().current).toBe(true);
    await probe.render(false);
    expect(probe.last().current).toBe(false);
  });
});
