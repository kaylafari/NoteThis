import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { X509Certificate, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
export const DEFAULT_SIGNING_DIRECTORY = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "NoteThis Build Signing",
);
const SETUP_HELP =
  "Run node scripts/local-signing.mjs --setup once to create the local identity.";

/** Never propagate execFile errors: their message and command fields can contain passwords. */
export async function runSigningCommand(file, args, label, run = exec) {
  try {
    return await run(file, args, {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error(
      `Local signing: ${label} failed. Command output was withheld to protect keychain credentials.`,
    );
  }
}

function paths(stateDir) {
  return {
    stateDir: path.resolve(stateDir),
    keychainPath: path.join(path.resolve(stateDir), "signing.keychain-db"),
    certificatePath: path.join(path.resolve(stateDir), "certificate.pem"),
    passwordPath: path.join(path.resolve(stateDir), "keychain-password"),
    metadataPath: path.join(path.resolve(stateDir), "identity.json"),
  };
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new Error("Local signing: could not inspect identity storage.");
  }
}

async function privateEntry(file, directory = false) {
  let stat;
  try {
    stat = await lstat(file);
  } catch {
    throw new Error(
      "Local signing identity is incomplete. Restore the existing identity from backup; do not regenerate it or delete its keychain.",
    );
  }
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error(
      "Local signing storage must be owned by this user, with directory mode 0700 and file mode 0600, and must not contain symbolic links.",
    );
  }
}

function inspectCertificate(pem, fingerprint, commonName) {
  let cert;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new Error(
      "Local signing certificate is invalid. Restore the original identity; it will not be replaced automatically.",
    );
  }
  const actual = cert.fingerprint.replaceAll(":", "").toUpperCase();
  if (fingerprint && actual !== fingerprint)
    throw new Error(
      "Local signing certificate fingerprint does not match its saved identity. Refusing to rotate or use another identity.",
    );
  if (
    cert.issuer !== cert.subject ||
    !cert.verify(cert.publicKey) ||
    !cert.keyUsage?.includes("1.3.6.1.5.5.7.3.3") ||
    cert.subject !== `CN=${commonName}`
  )
    throw new Error(
      "Local signing certificate must be the saved self-signed code-signing identity.",
    );
  const now = Date.now();
  if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now)
    throw new Error(
      "Local signing certificate is outside its validity period. Preserve the existing identity and resolve it manually.",
    );
  return actual;
}

async function loadIdentity(state) {
  await privateEntry(state.stateDir, true);
  for (const file of [
    state.certificatePath,
    state.passwordPath,
    state.metadataPath,
    state.keychainPath,
  ])
    await privateEntry(file);
  let metadata, pem, password;
  try {
    metadata = JSON.parse(await readFile(state.metadataPath, "utf8"));
    pem = await readFile(state.certificatePath, "utf8");
    password = await readFile(state.passwordPath, "utf8");
  } catch {
    throw new Error(
      "Local signing identity could not be read. Restore the existing files; they will not be replaced automatically.",
    );
  }
  if (
    metadata.version !== 1 ||
    !/^[A-F0-9]{40}$/.test(metadata.fingerprint || "") ||
    metadata.commonName !== "NoteThis Local Signing" ||
    !/^[a-f0-9]{64}$/.test(password)
  )
    throw new Error(
      "Local signing identity metadata is incomplete or invalid. Restore the existing identity instead of replacing it.",
    );
  inspectCertificate(pem, metadata.fingerprint, metadata.commonName);
  return {
    stateDir: state.stateDir,
    keychainPath: state.keychainPath,
    certificatePath: state.certificatePath,
    fingerprint: metadata.fingerprint,
    identity: metadata.fingerprint,
    commonName: metadata.commonName,
  };
}

function keychainList(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (!line.startsWith('"') || !line.endsWith('"'))
        throw new Error(
          "Local signing: could not safely read the keychain search list.",
        );
      try {
        const value = JSON.parse(line);
        if (typeof value !== "string" || !path.isAbsolute(value))
          throw new Error();
        return value;
      } catch {
        throw new Error(
          "Local signing: could not safely read the keychain search list.",
        );
      }
    });
}

/** A setup operation only; ordinary builds never create or replace an identity. */
async function createIdentity(state, run) {
  const before = keychainList(
    (
      await runSigningCommand(
        "/usr/bin/security",
        ["list-keychains", "-d", "user"],
        "read keychain search list",
        run,
      )
    ).stdout,
  );
  await mkdir(path.dirname(state.stateDir), { recursive: true });
  try {
    await mkdir(state.stateDir, { mode: 0o700 });
  } catch {
    throw new Error(
      "Local signing state already exists or cannot be created. Existing identity files are never overwritten.",
    );
  }
  const password = randomBytes(32).toString("hex"),
    archivePassword = randomBytes(32).toString("hex");
  const commonName = "NoteThis Local Signing";
  await writeFile(state.passwordPath, password, { mode: 0o600, flag: "wx" });
  const scratch = await mkdtemp(path.join(state.stateDir, ".setup-"));
  await chmod(scratch, 0o700);
  const privateKey = path.join(scratch, "private.pem"),
    certificate = path.join(scratch, "certificate.pem"),
    archive = path.join(scratch, "identity.p12"),
    passFile = path.join(scratch, "archive-password"),
    config = path.join(scratch, "openssl.cnf");
  let keychainCreated = false;
  try {
    await writeFile(passFile, archivePassword, { mode: 0o600, flag: "wx" });
    await writeFile(
      config,
      `[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=signing\n[subject]\nCN=${commonName}\n[signing]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\n`,
      { mode: 0o600, flag: "wx" },
    );
    await runSigningCommand(
      "/usr/bin/openssl",
      [
        "req",
        "-new",
        "-x509",
        "-newkey",
        "rsa:3072",
        "-nodes",
        "-sha256",
        "-days",
        "3650",
        "-config",
        config,
        "-keyout",
        privateKey,
        "-out",
        certificate,
      ],
      "create local code-signing certificate",
      run,
    );
    await chmod(privateKey, 0o600);
    await chmod(certificate, 0o600);
    const pem = await readFile(certificate, "utf8"),
      fingerprint = inspectCertificate(pem, undefined, commonName);
    await runSigningCommand(
      "/usr/bin/openssl",
      [
        "pkcs12",
        "-export",
        "-inkey",
        privateKey,
        "-in",
        certificate,
        "-name",
        commonName,
        "-out",
        archive,
        "-passout",
        `file:${passFile}`,
        "-keypbe",
        "PBE-SHA1-3DES",
        "-certpbe",
        "PBE-SHA1-3DES",
        "-macalg",
        "sha1",
      ],
      "prepare local signing identity for import",
      run,
    );
    await chmod(archive, 0o600);
    await runSigningCommand(
      "/usr/bin/security",
      ["create-keychain", "-p", password, state.keychainPath],
      "create dedicated build keychain",
      run,
    );
    keychainCreated = true;
    await chmod(state.keychainPath, 0o600);
    await runSigningCommand(
      "/usr/bin/security",
      ["unlock-keychain", "-p", password, state.keychainPath],
      "unlock dedicated build keychain for setup",
      run,
    );
    await runSigningCommand(
      "/usr/bin/security",
      [
        "import",
        archive,
        "-k",
        state.keychainPath,
        "-P",
        archivePassword,
        "-x",
        "-T",
        "/usr/bin/codesign",
      ],
      "import non-exportable code-signing key",
      run,
    );
    await writeFile(state.certificatePath, pem, { mode: 0o600, flag: "wx" });
    await writeFile(
      state.metadataPath,
      JSON.stringify(
        {
          version: 1,
          commonName,
          fingerprint,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  } finally {
    // Remove plaintext/PKCS#12 key material even after a failed import. Keep any
    // persistent partial state for manual recovery; never create a replacement.
    try {
      await rm(scratch, { recursive: true, force: true });
    } finally {
      if (keychainCreated || (await exists(state.keychainPath))) {
        try {
          await runSigningCommand(
            "/usr/bin/security",
            ["lock-keychain", state.keychainPath],
            "lock dedicated build keychain after setup",
            run,
          );
        } finally {
          const current = keychainList(
            (
              await runSigningCommand(
                "/usr/bin/security",
                ["list-keychains", "-d", "user"],
                "re-read keychain search list",
                run,
              )
            ).stdout,
          );
          if (
            !before.some(
              (entry) => path.resolve(entry) === state.keychainPath,
            ) &&
            current.some((entry) => path.resolve(entry) === state.keychainPath)
          ) {
            await runSigningCommand(
              "/usr/bin/security",
              [
                "list-keychains",
                "-d",
                "user",
                "-s",
                ...current.filter(
                  (entry) => path.resolve(entry) !== state.keychainPath,
                ),
              ],
              "remove only the dedicated chain from the current search list",
              run,
            );
          }
        }
      }
    }
  }
  return loadIdentity(state);
}

export async function getLocalSigningIdentity({
  create = false,
  stateDir = DEFAULT_SIGNING_DIRECTORY,
  platform = process.platform,
  run = exec,
} = {}) {
  if (platform !== "darwin")
    throw new Error("Local NoteThis code signing is available only on macOS.");
  const state = paths(stateDir);
  if (await exists(state.stateDir)) return loadIdentity(state);
  if (!create)
    throw new Error(`Local signing identity is not set up. ${SETUP_HELP}`);
  return createIdentity(state, run);
}

/** Passwords stay inside this function and are never returned to signing callers. */
export async function withUnlockedLocalSigningIdentity(
  identity,
  callback,
  { run = exec } = {},
) {
  const state = paths(identity.stateDir);
  const verified = await loadIdentity(state);
  if (
    verified.fingerprint !== identity.fingerprint ||
    verified.keychainPath !== identity.keychainPath
  )
    throw new Error(
      "Local signing identity changed before use. Refusing to sign.",
    );
  const password = await readFile(state.passwordPath, "utf8");
  let addedToSearchList = false;
  try {
    await runSigningCommand(
      "/usr/bin/security",
      ["unlock-keychain", "-p", password, state.keychainPath],
      "unlock dedicated build keychain for signing",
      run,
    );
    // codesign can resolve the certificate through --keychain yet still need
    // its private key through the user search list. Include this chain only
    // for the signing operation; never replace or select a default keychain.
    const current = keychainList(
      (
        await runSigningCommand(
          "/usr/bin/security",
          ["list-keychains", "-d", "user"],
          "read keychain search list for signing",
          run,
        )
      ).stdout,
    );
    if (!current.some((entry) => path.resolve(entry) === state.keychainPath)) {
      addedToSearchList = true;
      await runSigningCommand(
        "/usr/bin/security",
        ["list-keychains", "-d", "user", "-s", ...current, state.keychainPath],
        "temporarily include dedicated signing keychain",
        run,
      );
    }
    return await callback(verified);
  } finally {
    try {
      await runSigningCommand(
        "/usr/bin/security",
        ["lock-keychain", state.keychainPath],
        "lock dedicated build keychain after signing",
        run,
      );
    } finally {
      if (addedToSearchList) {
        const current = keychainList(
          (
            await runSigningCommand(
              "/usr/bin/security",
              ["list-keychains", "-d", "user"],
              "read current keychain search list after signing",
              run,
            )
          ).stdout,
        );
        if (
          current.some((entry) => path.resolve(entry) === state.keychainPath)
        ) {
          await runSigningCommand(
            "/usr/bin/security",
            [
              "list-keychains",
              "-d",
              "user",
              "-s",
              ...current.filter(
                (entry) => path.resolve(entry) !== state.keychainPath,
              ),
            ],
            "remove only the temporary signing keychain entry",
            run,
          );
        }
      }
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const flags = process.argv.slice(2);
  if (flags.length !== 1 || !["--setup", "--check"].includes(flags[0])) {
    console.error("Usage: node scripts/local-signing.mjs --setup | --check");
    process.exitCode = 1;
  } else {
    getLocalSigningIdentity({ create: flags[0] === "--setup" })
      .then((identity) => {
        console.log(
          `NoteThis local signing identity ready: ${identity.fingerprint}`,
        );
        console.log(`Dedicated keychain: ${identity.keychainPath}`);
      })
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
