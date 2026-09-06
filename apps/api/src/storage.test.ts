import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyStorePathKind } from "./lib/storage.ts";

describe("classifyStorePathKind", () => {
  it("treats empty and relative dirs as ephemeral", () => {
    assert.equal(classifyStorePathKind(""), "ephemeral");
    assert.equal(classifyStorePathKind("./data/files", { cwd: "/app" }), "ephemeral");
  });

  it("treats Render-style mounts as persistent", () => {
    assert.equal(classifyStorePathKind("/var/data/files", { cwd: "/opt/render/project/src" }), "persistent");
    assert.equal(classifyStorePathKind("/data/files", { cwd: "/opt/render/project/src" }), "persistent");
  });

  it("honours STORAGE_PERSISTENT flag", () => {
    assert.equal(classifyStorePathKind("./data/files", { persistentFlag: "1" }), "persistent");
  });
});
