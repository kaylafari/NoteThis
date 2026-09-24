import { describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { createSecretCodec } from "../desktop/secret-codec.js";

// Mirrors Chromium's macOS v10 format using a synthetic password, never Keychain.
const key = pbkdf2Sync(
  "synthetic-keychain-password",
  "saltysalt",
  1003,
  16,
  "sha1",
);
const iv = Buffer.alloc(16, 32);
function legacyCipher(value: string) {
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(value),
    cipher.final(),
  ]);
}
function fixtureStorage() {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => "gnome_libsecret" as const),
    encryptString: vi.fn(legacyCipher),
    decryptString: vi.fn(() => "legacy sync result"),
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async (value: string) => legacyCipher(value)),
    decryptStringAsync: vi.fn(async (value: Buffer) => {
      const decipher = createDecipheriv("aes-128-cbc", key, iv);
      return {
        result: Buffer.concat([
          decipher.update(value.subarray(3)),
          decipher.final(),
        ]).toString(),
        shouldReEncrypt: false,
      };
    }),
  };
}
describe("desktop credential codec", () => {
  it("decrypts existing macOS v10 ciphertext through async APIs without using the sync cache", async () => {
    const storage = fixtureStorage();
    const codec = createSecretCodec(storage, "darwin");
    const saved = legacyCipher("synthetic stored OAuth data").toString(
      "base64",
    );
    expect(await codec.decrypt(saved)).toBe("synthetic stored OAuth data");
    expect(await codec.encrypt("synthetic new API key")).toBe(
      legacyCipher("synthetic new API key").toString("base64"),
    );
    expect(storage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(storage.encryptString).not.toHaveBeenCalled();
    expect(storage.decryptString).not.toHaveBeenCalled();
  });
  it("does not access the credential store until a secret is requested", () => {
    const storage = fixtureStorage();
    createSecretCodec(storage, "darwin");
    expect(storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
  });
  it("fails closed when async availability is false", async () => {
    const storage = fixtureStorage();
    storage.isAsyncEncryptionAvailable.mockResolvedValue(false);
    const codec = createSecretCodec(storage, "darwin");
    await expect(codec.encrypt("secret")).rejects.toThrow(
      "secure credential store is unavailable",
    );
    await expect(
      codec.decrypt(legacyCipher("secret").toString("base64")),
    ).rejects.toThrow("secure credential store is unavailable");
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
    expect(storage.decryptStringAsync).not.toHaveBeenCalled();
    expect(storage.encryptString).not.toHaveBeenCalled();
  });
  it("propagates keychain denial even if async initialization reports available, without sync fallback", async () => {
    const storage = fixtureStorage();
    storage.encryptStringAsync.mockRejectedValue(new Error("Keychain denied"));
    storage.decryptStringAsync.mockRejectedValue(new Error("Keychain denied"));
    const codec = createSecretCodec(storage, "darwin");
    await expect(codec.encrypt("secret")).rejects.toThrow("Keychain denied");
    await expect(
      codec.decrypt(legacyCipher("secret").toString("base64")),
    ).rejects.toThrow("Keychain denied");
    expect(storage.isEncryptionAvailable).not.toHaveBeenCalled();
  });
  it("rejects plaintext or malformed ciphertext rather than passing it through", async () => {
    const storage = fixtureStorage();
    const codec = createSecretCodec(storage, "darwin");
    for (const value of [
      "",
      Buffer.from("unencrypted").toString("base64"),
      Buffer.from("v10bad").toString("base64"),
    ])
      await expect(codec.decrypt(value)).rejects.toThrow("encrypted value");
    expect(storage.decryptStringAsync).not.toHaveBeenCalled();
    storage.encryptStringAsync.mockResolvedValue(Buffer.from("unencrypted"));
    await expect(codec.encrypt("secret")).rejects.toThrow(
      "did not return encrypted",
    );
  });
  it.each(["linux", "win32"] as const)(
    "preserves existing synchronous %s behavior",
    async (platform) => {
      const storage = fixtureStorage();
      const codec = createSecretCodec(storage, platform);
      expect(await codec.encrypt("secret")).toBe(
        legacyCipher("secret").toString("base64"),
      );
      expect(
        await codec.decrypt(legacyCipher("secret").toString("base64")),
      ).toBe("legacy sync result");
      expect(storage.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
    },
  );
  it("still refuses Linux basic_text encryption", () => {
    const storage = {
      ...fixtureStorage(),
      getSelectedStorageBackend: vi.fn(() => "basic_text" as const),
    };
    const codec = createSecretCodec(storage, "linux");
    expect(() => codec.encrypt("secret")).toThrow(
      "secure credential store is unavailable",
    );
    expect(storage.encryptString).not.toHaveBeenCalled();
  });
});
