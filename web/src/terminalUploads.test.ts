import { afterEach, describe, expect, it, vi } from "vitest";

import { supportsUploads, uploadWithOverwritePrompt } from "./terminalUploads";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadWithOverwritePrompt", () => {
  it("requests atomic conflict renaming when the setting is enabled", async () => {
    const fetchMock = vi.fn().mockResolvedValue(uploadResponse("image-1.png"));
    vi.stubGlobal("fetch", fetchMock);
    const confirmReplace = vi.fn();

    const uploaded = await uploadWithOverwritePrompt(
      testHttpUrl,
      imageFile(),
      true,
      confirmReplace,
    );

    expect(uploaded.name).toBe("image-1.png");
    expect(requestQuery(fetchMock)).toEqual({
      name: "image.png",
      rename_conflicts: "true",
    });
    expect(confirmReplace).not.toHaveBeenCalled();
  });

  it("keeps the Replace or Cancel prompt when automatic renaming is disabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(conflictResponse("image.png"))
      .mockResolvedValueOnce(uploadResponse("image.png"));
    vi.stubGlobal("fetch", fetchMock);
    const confirmReplace = vi.fn().mockResolvedValue(true);

    await uploadWithOverwritePrompt(testHttpUrl, imageFile(), false, confirmReplace);

    expect(confirmReplace).toHaveBeenCalledOnce();
    expect(requestQuery(fetchMock, 0)).toEqual({ name: "image.png" });
    expect(requestQuery(fetchMock, 1)).toEqual({ name: "image.png", overwrite: "true" });
  });

  it("rejects a malformed upload payload instead of trusting the server's shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ file: "not-an-object" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadWithOverwritePrompt(testHttpUrl, imageFile(), true, vi.fn()),
    ).rejects.toThrow("Upload failed (200)");
  });

  it("does not offer replacement when automatic suffixes are exhausted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "no available filename for image.png" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const confirmReplace = vi.fn();

    await expect(
      uploadWithOverwritePrompt(testHttpUrl, imageFile(), true, confirmReplace),
    ).rejects.toThrow("no available filename for image.png");
    expect(confirmReplace).not.toHaveBeenCalled();
  });
});

function imageFile() {
  return {
    blob: new Blob(["image"], { type: "image/png" }),
    name: "image.png",
  };
}

function testHttpUrl(path: string, query?: URLSearchParams) {
  const suffix = query && query.size > 0 ? `?${query}` : "";
  return `http://bridge.test${path}${suffix}`;
}

function uploadResponse(name: string) {
  return new Response(
    JSON.stringify({
      file: {
        name,
        path: `/uploads/${name}`,
        size: 5,
        mime: "image/png",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function conflictResponse(name: string) {
  return new Response(
    JSON.stringify({ error: "file exists", name, path: `/uploads/${name}` }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

function requestQuery(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  const url = new URL(String(fetchMock.mock.calls[call]?.[0]));
  return Object.fromEntries(url.searchParams.entries());
}

describe("supportsUploads", () => {
  it("keeps uploads available for legacy local bridges without capability fields", () => {
    expect(supportsUploads(null)).toBe(true);
    expect(supportsUploads(undefined)).toBe(true);
    expect(supportsUploads({ commands: ["command"] })).toBe(true);
  });

  it("keeps uploads for machines-aware local and configured bridges that do not advertise uploads", () => {
    expect(supportsUploads({ commands: [], machines: { version: 1 } })).toBe(true);
    expect(supportsUploads({ commands: [], machines: { version: 1 } }, false)).toBe(true);
  });

  it("hides uploads on machine-scoped runtimes that do not advertise them", () => {
    expect(supportsUploads({ commands: [], machines: { version: 1 } }, true)).toBe(false);
    expect(supportsUploads(null, true)).toBe(false);
  });

  it("honors an explicit uploads capability in every runtime mode", () => {
    expect(supportsUploads({ commands: [], uploads: { version: 1 } })).toBe(true);
    expect(
      supportsUploads({ commands: [], machines: { version: 1 }, uploads: { version: 1 } }, true),
    ).toBe(true);
  });

  it("rejects unknown uploads capability versions", () => {
    expect(
      supportsUploads({ commands: [], uploads: { version: 2 } as unknown as { version: 1 } }),
    ).toBe(false);
  });
});
