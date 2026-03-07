/**
 * Tests for Image infrastructure (images.ts)
 *
 * Tests cleanup behavior and directory exports using real file system.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { cleanupImageFile, IMAGES_DIR, IMAGES_INCOMING_DIR } from "../images.js";

describe("cleanupImageFile", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "images-test-"));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should delete an existing file", () => {
    const testFile = path.join(testDir, "test.jpg");
    fs.writeFileSync(testFile, "fake image data");
    expect(fs.existsSync(testFile)).toBe(true);

    cleanupImageFile(testFile);

    expect(fs.existsSync(testFile)).toBe(false);
  });

  it("should not throw when file does not exist", () => {
    const nonExistent = path.join(testDir, "no-such-file.jpg");

    expect(() => cleanupImageFile(nonExistent)).not.toThrow();
  });

  it("should not throw when path is a directory", () => {
    const subDir = path.join(testDir, "subdir");
    fs.mkdirSync(subDir);

    // Should not throw — the try/catch in cleanupImageFile handles this
    expect(() => cleanupImageFile(subDir)).not.toThrow();
  });
});

describe("image directory exports", () => {
  it("should export IMAGES_DIR ending with .borg/images", () => {
    expect(IMAGES_DIR).toMatch(/\.borg\/images$/);
  });

  it("should export IMAGES_INCOMING_DIR ending with .borg/images/incoming", () => {
    expect(IMAGES_INCOMING_DIR).toMatch(/\.borg\/images\/incoming$/);
  });

  it("should have IMAGES_INCOMING_DIR as child of IMAGES_DIR", () => {
    expect(IMAGES_INCOMING_DIR.startsWith(IMAGES_DIR)).toBe(true);
  });
});
