import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageImportJob } from "../ipc/bindings/ImageImportJob";

const dockerImages = vi.fn();
vi.mock("../ipc/api", () => ({
  api: { dockerImages: (...a: unknown[]) => dockerImages(...a) },
  asCoreError: (e: unknown) => ({ message: e instanceof Error ? e.message : String(e) }),
}));

import { useDockerImages, useImageImports } from "./docker";

const job = (over: Partial<ImageImportJob>): ImageImportJob => ({
  id: "j1",
  host_id: "h1",
  path: "/x/a.tar",
  state: "running",
  phase: "uploading",
  bytes: 0,
  total: 10,
  loaded: [],
  error: null,
  note: null,
  ...over,
});

describe("useImageImports", () => {
  beforeEach(() => {
    dockerImages.mockReset();
    dockerImages.mockResolvedValue([]);
    useImageImports.setState({ jobs: {}, recent: {} });
    useDockerImages.setState({ byHost: { h1: { images: [], error: null, at: 1, loading: false } } });
  });

  it("keeps progress and reloads the images once, when the job ends", () => {
    const s = useImageImports.getState();
    s.received(job({ bytes: 3 }));
    s.received(job({ bytes: 10, phase: "loading" }));
    expect(dockerImages).not.toHaveBeenCalled();
    s.received(job({ state: "done", phase: "", loaded: ["myapp:latest"] }));
    s.received(job({ state: "done", phase: "", loaded: ["myapp:latest"] })); // repeated event
    expect(dockerImages).toHaveBeenCalledTimes(1);
    expect(useImageImports.getState().jobs.j1.state).toBe("done");
    expect(useImageImports.getState().recent.h1).toEqual(["myapp:latest"]);
  });

  it("also reloads after a failure or cancel (a load may have added images)", () => {
    useImageImports.getState().received(job({ id: "a", state: "failed", error: "boom" }));
    useImageImports.getState().received(job({ id: "b", state: "cancelled" }));
    expect(dockerImages).toHaveBeenCalledTimes(2);
    expect(useImageImports.getState().recent.h1).toBeUndefined();
  });

  it("does not load a list nobody opened", () => {
    useDockerImages.setState({ byHost: {} });
    useImageImports.getState().received(job({ state: "done", loaded: ["a:1"] }));
    expect(dockerImages).not.toHaveBeenCalled();
  });

  it("forgets the pinned images when their status row is dismissed", () => {
    useImageImports.getState().received(job({ state: "done", loaded: ["a:1"] }));
    useImageImports.getState().dismiss("j1");
    expect(useImageImports.getState().jobs).toEqual({});
    expect(useImageImports.getState().recent).toEqual({});
  });
});
