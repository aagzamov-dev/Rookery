import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerImage } from "../ipc/bindings/DockerImage";

const dockerImages = vi.fn();
vi.mock("../ipc/api", () => ({
  api: { dockerImages: (...a: unknown[]) => dockerImages(...a) },
  asCoreError: (e: unknown) => ({ message: e instanceof Error ? e.message : String(e) }),
}));

import { useDockerImages } from "./docker";

const img = (ref: string): DockerImage => ({ id: ref, repository: ref, tag: "1", reference: `${ref}:1`, size: 1, created_at: 1, containers: [] });

describe("useDockerImages", () => {
  beforeEach(() => {
    dockerImages.mockReset();
    useDockerImages.setState({ byHost: {} });
  });

  it("loads once per request and records the time", async () => {
    dockerImages.mockResolvedValue([img("a")]);
    await useDockerImages.getState().load("h1");
    const d = useDockerImages.getState().byHost.h1;
    expect(d.images.map((i) => i.id)).toEqual(["a"]);
    expect(d.error).toBeNull();
    expect(d.at).not.toBeNull();
    expect(d.loading).toBe(false);
  });

  it("keeps the last good list when a refresh fails", async () => {
    dockerImages.mockResolvedValueOnce([img("a")]);
    await useDockerImages.getState().load("h1");
    dockerImages.mockRejectedValueOnce(new Error("permission denied"));
    await useDockerImages.getState().load("h1");
    const d = useDockerImages.getState().byHost.h1;
    expect(d.images).toHaveLength(1);
    expect(d.error).toBe("permission denied");
  });

  it("ignores an older answer that arrives after a newer request", async () => {
    let first!: (v: DockerImage[]) => void;
    dockerImages.mockImplementationOnce(() => new Promise((r) => (first = r)));
    dockerImages.mockResolvedValueOnce([img("new")]);
    const slow = useDockerImages.getState().load("h1");
    await useDockerImages.getState().load("h1");
    first([img("old")]);
    await slow;
    expect(useDockerImages.getState().byHost.h1.images.map((i) => i.id)).toEqual(["new"]);
  });

  it("forget clears the host so the view loads again", async () => {
    dockerImages.mockResolvedValue([]);
    await useDockerImages.getState().load("h1");
    useDockerImages.getState().forget("h1");
    expect(useDockerImages.getState().byHost.h1).toBeUndefined();
  });
});
