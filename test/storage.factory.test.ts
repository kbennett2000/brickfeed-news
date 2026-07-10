import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageProvider, BlobStorageProvider, LocalStorageProvider } from "../src/storage/index.js";
import { makeConfig } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createStorageProvider", () => {
  it("defaults to the Blob provider", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test-token");
    const provider = createStorageProvider(makeConfig());
    expect(provider).toBeInstanceOf(BlobStorageProvider);
  });

  it("returns the local provider when configured", () => {
    const config = makeConfig({
      storage: {
        provider: "local",
        blob: { pathPrefix: "images/", publicBaseUrl: "" },
        local: { dir: "/tmp/x", publicBaseUrl: "http://x/blob" },
      },
    });
    expect(createStorageProvider(config)).toBeInstanceOf(LocalStorageProvider);
  });

  it("warns (advisory, non-blocking) when blob is selected without a token", () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = createStorageProvider(makeConfig());
    expect(provider).toBeInstanceOf(BlobStorageProvider);
    expect(warn).toHaveBeenCalledOnce();
  });
});
