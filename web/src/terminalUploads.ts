import type { BridgeCapabilities } from "./bridge";

export type UploadCandidate = {
  blob: Blob;
  name: string | null;
};

export type UploadedFile = {
  name: string;
  path: string;
  size: number;
  mime?: string | null;
};

export class UploadConflictError extends Error {
  constructor(
    readonly name: string,
    readonly path: string,
  ) {
    super(`file exists: ${path || name}`);
  }
}

export async function uploadWithOverwritePrompt(
  httpUrl: (path: string, query?: URLSearchParams) => string,
  file: UploadCandidate,
  autoRenameConflicts: boolean,
  confirmReplace: (error: UploadConflictError) => Promise<boolean>,
): Promise<UploadedFile> {
  try {
    return await uploadFile(httpUrl, file, false, autoRenameConflicts);
  } catch (error) {
    if (!(error instanceof UploadConflictError)) {
      throw error;
    }
    const replace = await confirmReplace(error);
    if (!replace) {
      throw new Error("Upload canceled");
    }
    return uploadFile(httpUrl, file, true, false);
  }
}

async function uploadFile(
  httpUrl: (path: string, query?: URLSearchParams) => string,
  file: UploadCandidate,
  overwrite: boolean,
  renameConflicts: boolean,
): Promise<UploadedFile> {
  const params = new URLSearchParams();
  if (file.name) {
    params.set("name", file.name);
  }
  if (overwrite) {
    params.set("overwrite", "true");
  } else if (renameConflicts) {
    params.set("rename_conflicts", "true");
  }
  const response = await fetch(httpUrl("/api/uploads", params), {
    method: "POST",
    headers: file.blob.type ? { "content-type": file.blob.type } : undefined,
    body: file.blob,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    file?: UploadedFile;
    error?: string;
    name?: string;
    path?: string;
  };
  if (response.status === 409 && !renameConflicts) {
    throw new UploadConflictError(
      typeof payload.name === "string" ? payload.name : file.name || "file",
      typeof payload.path === "string" ? payload.path : "",
    );
  }
  if (!response.ok || !payload.file) {
    throw new Error(payload.error || `Upload failed (${response.status})`);
  }
  return payload.file;
}

/**
 * Whether the runtime behind these capabilities supports file uploads.
 *
 * `machineScoped` selects the fallback for runtimes without an explicit
 * `uploads` advertisement. Local, same-origin, and configured HTTP bridges
 * have always served the local `/api/uploads` route, so uploads stay enabled
 * for them — including older machines-aware (stage-1) bridges that predate
 * the field. Machine-scoped runtimes only exist on capability-speaking
 * bridges, so without an explicit `uploads` advertisement they have no upload
 * path at all.
 */
export function supportsUploads(
  capabilities: BridgeCapabilities | null | undefined,
  machineScoped = false,
): boolean {
  if (capabilities?.uploads) {
    return capabilities.uploads.version === 1;
  }
  return !machineScoped;
}
