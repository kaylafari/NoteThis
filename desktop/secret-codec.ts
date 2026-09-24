import type { SafeStorage } from "electron";
import type { SecretCodec } from "../server/storage.js";

type SecureStorage = Pick<
  SafeStorage,
  | "isEncryptionAvailable"
  | "getSelectedStorageBackend"
  | "encryptString"
  | "decryptString"
  | "isAsyncEncryptionAvailable"
  | "encryptStringAsync"
  | "decryptStringAsync"
>;
const unavailable =
  "The operating system secure credential store is unavailable. Unlock your keychain or configure a system keyring before saving provider credentials.";

/** macOS shares Chromium's async keychain provider instead of opening a second sync cache. */
export function createSecretCodec(
  storage: SecureStorage,
  platform: NodeJS.Platform,
): SecretCodec {
  if (platform === "darwin") {
    return {
      async encrypt(value) {
        if (!(await storage.isAsyncEncryptionAvailable()))
          throw new Error(unavailable);
        // Availability can mean initialization completed even if access was denied.
        // The operation must succeed; never fall back to another storage mechanism.
        const encrypted = await storage.encryptStringAsync(value);
        if (
          value &&
          (encrypted.length < 19 ||
            encrypted.subarray(0, 3).toString() !== "v10")
        )
          throw new Error(
            "The operating system did not return encrypted credential data.",
          );
        return encrypted.toString("base64");
      },
      async decrypt(value) {
        const encrypted = Buffer.from(value, "base64");
        if (
          encrypted.length < 19 ||
          encrypted.subarray(0, 3).toString() !== "v10"
        )
          throw new Error(
            "Saved credential data is not a supported encrypted value.",
          );
        if (!(await storage.isAsyncEncryptionAvailable()))
          throw new Error(unavailable);
        // macOS sync and async APIs use the same v10 cipher and legacy keychain item.
        // Leave the existing ciphertext untouched; no credential migration is needed.
        return (await storage.decryptStringAsync(encrypted)).result;
      },
    };
  }
  return {
    encrypt(value) {
      if (
        !storage.isEncryptionAvailable() ||
        (platform === "linux" &&
          storage.getSelectedStorageBackend() === "basic_text")
      )
        throw new Error(unavailable);
      return storage.encryptString(value).toString("base64");
    },
    decrypt(value) {
      if (!storage.isEncryptionAvailable())
        throw new Error(
          "Unlock the operating system credential store to access saved credentials.",
        );
      return storage.decryptString(Buffer.from(value, "base64"));
    },
  };
}
