import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  chmod,
  rm,
  stat,
  symlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { X509Certificate } from "node:crypto";

// These modules deliberately run as plain Node scripts outside the app bundle.
const signing = await import(
  pathToFileURL(path.resolve("scripts/local-signing.mjs")).href
);
const { default: hook } = await import(
  pathToFileURL(path.resolve("scripts/sign-local-mac.cjs")).href
);
const PUBLIC_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIC/TCCAeWgAwIBAgIJAL1CHj3GihBFMA0GCSqGSIb3DQEBCwUAMCExHzAdBgNV
BAMMFk5vdGVUaGlzIExvY2FsIFNpZ25pbmcwHhcNMjYwOTI0MTU0NzU1WhcNMzYw
OTIxMTU0NzU1WjAhMR8wHQYDVQQDDBZOb3RlVGhpcyBMb2NhbCBTaWduaW5nMIIB
IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1idi6r/38MfgT/kAQEz2NW9g
ypy/HE7QYFb123iu0VnL1QVEfjK4qsS/IyjmR0a8KtosZscNh0+KClaNFj1UavsO
Vn4Vu+67ztfW5W+oOeW01iRJLM71y3mTZ7B9fd4lsrQn/vdt/1Kw+Q2wO0bO1pzz
jIe1WwYIIdMx0d84oc1Jj0h+Hsk2BVGYDYAKFFP0po0yyuXMVKzRhEE8J4aAflBx
msb2IzYz4r+LVBuClV1LZB4/L7tl1/Mg9OBHJWKpxzYksTiBDCs5fUIdBtDKbf8g
iLNSb3B8O7K9zfVRSAP9My790RYnqTI5VwElzgNmitMSSLEHSA41WZ54KHqhIwID
AQABozgwNjAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDAWBgNVHSUBAf8E
DDAKBggrBgEFBQcDAzANBgkqhkiG9w0BAQsFAAOCAQEAcg4qvkVYQj1H5c4IrweU
MpmbVWLJuTQEo4XXfeqbiLYGxVHgBPLuSIi/byxzvEz7QaZmJzI83xHOP1so3Lfi
SRW+PECp9b6mlveklRWhz8tfP0vfiD57LRhE1KKdJ42gCkGcDtieQtdFdkeI5zTN
5d9UbW0GQKh+J8KI+/bfOU7ADb5/vgsMIlHICO7CA+5BtsuE/AHOht/USm6zpkZY
OOVq9Gb637TX87+t0Pe0Egla0xY/qHLxj9PeVNLOpllUVevB5wNmybQrl7O62ss/
2iaLTZCee+KcG4aW1pwuLI3Wkfd6bE50gk+6iwPXcqSfMnIcP2raTDew9PKHHCoI
rA==
-----END CERTIFICATE-----
`;
const fingerprint = new X509Certificate(
  PUBLIC_CERTIFICATE,
).fingerprint.replaceAll(":", "");
let scratch: string;
beforeEach(async () => {
  scratch = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "notethis-signing-test-")),
  );
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function mockCommands(stateDir: string, failCommand?: string) {
  const calls: { file: string; args: string[] }[] = [];
  let created = false;
  const login = path.join(scratch, "login.keychain-db"),
    concurrent = path.join(scratch, "another-app.keychain-db"),
    dedicated = path.join(stateDir, "signing.keychain-db");
  const run = vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args });
    if (args[0] === failCommand)
      throw new Error(
        "Command failed: SECRET-PASSWORD with all command arguments",
      );
    if (file === "/usr/bin/openssl") {
      if (args[0] === "req") {
        await writeFile(args[args.indexOf("-out") + 1], PUBLIC_CERTIFICATE, {
          mode: 0o600,
        });
        await writeFile(
          args[args.indexOf("-keyout") + 1],
          "synthetic private key, never real",
          { mode: 0o600 },
        );
      } else
        await writeFile(args[args.indexOf("-out") + 1], "synthetic archive", {
          mode: 0o600,
        });
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "create-keychain") {
      created = true;
      await writeFile(dedicated, "synthetic keychain", { mode: 0o600 });
    }
    if (args[0] === "list-keychains" && !args.includes("-s"))
      return {
        stdout: (created ? [login, concurrent, dedicated] : [login])
          .map((value) => JSON.stringify(value))
          .join("\n"),
        stderr: "",
      };
    return { stdout: "", stderr: "" };
  });
  return { run, calls, login, concurrent, dedicated };
}

async function setup() {
  const stateDir = path.join(scratch, "state");
  const commands = mockCommands(stateDir);
  const identity = await signing.getLocalSigningIdentity({
    create: true,
    stateDir,
    platform: "darwin",
    run: commands.run,
  });
  return { stateDir, identity, ...commands };
}

describe("explicit local signing identity", () => {
  test("ordinary loading fails clearly instead of creating or rotating identity", async () => {
    const run = vi.fn();
    const stateDir = path.join(scratch, "missing");
    await expect(
      signing.getLocalSigningIdentity({ stateDir, platform: "darwin", run }),
    ).rejects.toThrow("--setup");
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(scratch)).toEqual([]);
    await expect(
      signing.getLocalSigningIdentity({
        create: true,
        stateDir,
        platform: "linux",
        run,
      }),
    ).rejects.toThrow("only on macOS");
    expect(run).not.toHaveBeenCalled();
  });

  test("setup imports only into a dedicated keychain with restricted access and preserves concurrent search-list entries", async () => {
    const { stateDir, identity, calls, login, concurrent, dedicated } =
      await setup();
    expect(identity.fingerprint).toBe(fingerprint);
    expect(identity.identity).toBe(fingerprint);
    const mode = (await stat(stateDir)).mode & 0o777;
    expect(mode).toBe(0o700);
    for (const entry of await readdir(stateDir))
      expect((await stat(path.join(stateDir, entry))).mode & 0o777).toBe(0o600);
    const imported = calls.find((call) => call.args[0] === "import")!;
    expect(imported.file).toBe("/usr/bin/security");
    expect(imported.args.includes("-x")).toBe(true);
    expect(imported.args.includes("-A")).toBe(false);
    expect(imported.args[imported.args.indexOf("-T") + 1]).toBe(
      "/usr/bin/codesign",
    );
    expect(imported.args[imported.args.indexOf("-k") + 1]).toBe(dedicated);
    const listUpdate = calls.find(
      (call) => call.args[0] === "list-keychains" && call.args.includes("-s"),
    )!;
    expect(listUpdate.args).toEqual([
      "list-keychains",
      "-d",
      "user",
      "-s",
      login,
      concurrent,
    ]);
    expect(
      calls.some((call) =>
        /trust|default-keychain|set-key-partition-list/.test(call.args[0]),
      ),
    ).toBe(false);
    expect(
      calls
        .filter((call) => call.args[0] === "lock-keychain")
        .map((call) => call.args.at(-1)),
    ).toEqual([dedicated]);
    expect(
      (await readdir(stateDir)).some((name) => name.startsWith(".setup-")),
    ).toBe(false);
    expect(
      Object.keys(identity).some((key) => /password|private/i.test(key)),
    ).toBe(false);
  });

  test("subsequent setup and checks reuse the exact identity without running commands", async () => {
    const { stateDir, identity } = await setup();
    const run = vi.fn();
    const again = await signing.getLocalSigningIdentity({
      create: true,
      stateDir,
      platform: "darwin",
      run,
    });
    const checked = await signing.getLocalSigningIdentity({
      stateDir,
      platform: "darwin",
      run,
    });
    expect(again).toEqual(identity);
    expect(checked).toEqual(identity);
    expect(run).not.toHaveBeenCalled();
  });

  test("partial setup is retained and never silently replaced", async () => {
    const stateDir = path.join(scratch, "state"),
      commands = mockCommands(stateDir, "import");
    await expect(
      signing.getLocalSigningIdentity({
        create: true,
        stateDir,
        platform: "darwin",
        run: commands.run,
      }),
    ).rejects.toThrow("import non-exportable");
    const files = await readdir(stateDir);
    expect(files).toContain("keychain-password");
    expect(files).toContain("signing.keychain-db");
    expect(files.some((name) => name.startsWith(".setup-"))).toBe(false);
    const count = commands.calls.length;
    await expect(
      signing.getLocalSigningIdentity({
        create: true,
        stateDir,
        platform: "darwin",
        run: commands.run,
      }),
    ).rejects.toThrow("incomplete");
    expect(commands.calls.length).toBe(count);
    expect(
      commands.calls.some((call) => call.args[0] === "lock-keychain"),
    ).toBe(true);
  });

  test("fingerprint mismatches, missing keychains, public storage and symlinks fail closed", async () => {
    const { stateDir } = await setup();
    const metadataPath = path.join(stateDir, "identity.json"),
      metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    await writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, fingerprint: "A".repeat(40) }),
    );
    await expect(
      signing.getLocalSigningIdentity({ stateDir, platform: "darwin" }),
    ).rejects.toThrow("fingerprint");
    await writeFile(metadataPath, JSON.stringify(metadata));
    await chmod(stateDir, 0o755);
    await expect(
      signing.getLocalSigningIdentity({ stateDir, platform: "darwin" }),
    ).rejects.toThrow("0700");
    await chmod(stateDir, 0o700);
    await rm(path.join(stateDir, "signing.keychain-db"));
    await expect(
      signing.getLocalSigningIdentity({
        create: true,
        stateDir,
        platform: "darwin",
      }),
    ).rejects.toThrow("incomplete");
    await symlink(
      path.join(scratch, "elsewhere"),
      path.join(stateDir, "signing.keychain-db"),
    );
    await expect(
      signing.getLocalSigningIdentity({ stateDir, platform: "darwin" }),
    ).rejects.toThrow("symbolic links");
  });

  test("keychain is locked after successful and failed signing callbacks", async () => {
    const { identity } = await setup();
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await expect(
      signing.withUnlockedLocalSigningIdentity(identity, async () => "signed", {
        run,
      }),
    ).resolves.toBe("signed");
    expect(
      run.mock.calls
        .map((call: any) => call[1][0])
        .filter((command: string) => command !== "list-keychains"),
    ).toEqual(["unlock-keychain", "lock-keychain"]);
    run.mockClear();
    await expect(
      signing.withUnlockedLocalSigningIdentity(
        identity,
        async () => {
          throw new Error("synthetic signing failure");
        },
        { run },
      ),
    ).rejects.toThrow("synthetic signing failure");
    expect(
      run.mock.calls
        .map((call: any) => call[1][0])
        .filter((command: string) => command !== "list-keychains"),
    ).toEqual(["unlock-keychain", "lock-keychain"]);
  });

  test("signing removes only its temporary search-list addition after callback failure", async () => {
    const { identity } = await setup();
    const login = path.join(scratch, "login.keychain-db");
    const concurrent = path.join(scratch, "concurrent.keychain-db");
    let current = [login];
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "list-keychains" && args.includes("-s"))
        current = args.slice(4);
      return {
        stdout:
          args[0] === "list-keychains" && !args.includes("-s")
            ? current.map((item) => JSON.stringify(item)).join("\n")
            : "",
        stderr: "",
      };
    });
    await expect(
      signing.withUnlockedLocalSigningIdentity(
        identity,
        async () => {
          expect(current).toEqual([login, identity.keychainPath]);
          current.push(concurrent);
          throw new Error("synthetic signing failure");
        },
        { run },
      ),
    ).rejects.toThrow("synthetic signing failure");
    expect(current).toEqual([login, concurrent]);
    expect(
      run.mock.calls.filter((call) => call[1][0] === "lock-keychain").length,
    ).toBe(1);
  });

  test("pre-existing search membership is preserved and cleanup still runs when locking fails", async () => {
    const { identity } = await setup();
    const login = path.join(scratch, "login.keychain-db");
    let current = [login, identity.keychainPath];
    let failLock = false;
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "lock-keychain" && failLock)
        throw new Error("synthetic locking failure");
      if (args[0] === "list-keychains" && args.includes("-s"))
        current = args.slice(4);
      return {
        stdout:
          args[0] === "list-keychains" && !args.includes("-s")
            ? current.map((item) => JSON.stringify(item)).join("\n")
            : "",
        stderr: "",
      };
    });
    await signing.withUnlockedLocalSigningIdentity(identity, async () => {}, {
      run,
    });
    expect(current).toEqual([login, identity.keychainPath]);
    expect(run.mock.calls.some((call) => call[1].includes("-s"))).toBe(false);
    current = [login];
    failLock = true;
    await expect(
      signing.withUnlockedLocalSigningIdentity(identity, async () => {}, {
        run,
      }),
    ).rejects.toThrow("lock dedicated build keychain after signing failed");
    expect(current).toEqual([login]);
  });

  test("exec failures never expose command arguments, raw stderr or password-bearing causes", async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(
        new Error(
          "SECRET-PASSWORD /usr/bin/security unlock-keychain -p SECRET-PASSWORD",
        ),
        { stderr: "SECRET-PASSWORD" },
      );
    });
    let captured: any;
    try {
      await signing.runSigningCommand(
        "/usr/bin/security",
        ["unlock-keychain", "-p", "SECRET-PASSWORD"],
        "unlock dedicated keychain",
        runner,
      );
    } catch (error) {
      captured = error;
    }
    expect(captured.message).toContain("unlock dedicated keychain failed");
    expect(String(captured)).not.toContain("SECRET-PASSWORD");
    expect(captured.cause).toBeUndefined();
    const { identity } = await setup();
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "unlock-keychain") throw new Error("SECRET-PASSWORD");
      return { stdout: "", stderr: "" };
    });
    await expect(
      signing.withUnlockedLocalSigningIdentity(identity, vi.fn(), { run }),
    ).rejects.toThrow("output was withheld");
    expect(
      run.mock.calls
        .map((call) => call[1][0])
        .filter((command) => command !== "list-keychains"),
    ).toEqual(["unlock-keychain", "lock-keychain"]);
  });
});

describe("packaging signature hook", () => {
  async function harness() {
    const appOutDir = path.join(scratch, "release"),
      app = path.join(appOutDir, "NoteThis.app");
    await mkdir(path.join(app, "Contents"), { recursive: true });
    const context = {
      electronPlatformName: "darwin",
      appOutDir,
      packager: {
        projectDir: scratch,
        appInfo: { productFilename: "NoteThis" },
      },
    };
    const identity = {
      fingerprint,
      keychainPath: path.join(scratch, "dedicated.keychain-db"),
    };
    const run = vi.fn(async (_file: string, args: string[]) => ({
      stdout: args[0] === "-extract" ? "com.cadence.meetingnotes\n" : "",
      stderr:
        args[0] === "-d"
          ? `designated => identifier "com.cadence.meetingnotes" and anchor H"${fingerprint}"`
          : "",
    }));
    let unlocked = false,
      relocked = false;
    const dependencies = {
      platform: "darwin",
      run,
      signAsync: vi.fn(async () => {}),
      signing: {
        runSigningCommand: signing.runSigningCommand,
        getLocalSigningIdentity: vi.fn(async () => identity),
        withUnlockedLocalSigningIdentity: vi.fn(
          async (_identity: any, action: (value: any) => Promise<void>) => {
            unlocked = true;
            try {
              await action(identity);
            } finally {
              relocked = true;
            }
          },
        ),
      },
    };
    return {
      context,
      dependencies,
      app,
      run,
      status: () => ({ unlocked, relocked }),
    };
  }
  test("signs nested contents using osx-sign with stable identity and verifies certificate-based requirement", async () => {
    const { context, dependencies, app, run, status } = await harness();
    await hook(context, dependencies);
    const options = (dependencies.signAsync.mock.calls as any)[0][0];
    expect(options.app).toBe(app);
    expect(options.identity).toBe(fingerprint);
    expect(options.identityValidation).toBe(false);
    expect(options.preAutoEntitlements).toBe(false);
    expect(options.preEmbedProvisioningProfile).toBe(false);
    expect(options.optionsForFile("nested")).toEqual({
      entitlements: path.join(scratch, "desktop", "entitlements.mac.plist"),
      hardenedRuntime: true,
      timestamp: "none",
    });
    expect(options.additionalArguments).toBeUndefined();
    expect(
      run.mock.calls.some(
        (call) => call[1].includes("--deep") && call[1][0] === "--verify",
      ),
    ).toBe(true);
    expect(dependencies.signing.getLocalSigningIdentity).toHaveBeenCalledWith({
      create: false,
    });
    expect(status()).toEqual({ unlocked: true, relocked: true });
  });
  test("non-mac packaging is skipped and wrong bundle IDs never unlock signing identity", async () => {
    const { context, dependencies } = await harness();
    await hook(context, { ...dependencies, platform: "linux" });
    expect(dependencies.run).not.toHaveBeenCalled();
    dependencies.run.mockResolvedValue({ stdout: "com.other.app", stderr: "" });
    await expect(hook(context, dependencies)).rejects.toThrow(
      "bundle other than",
    );
    expect(dependencies.signing.getLocalSigningIdentity).not.toHaveBeenCalled();
  });
  test("cdhash requirements and signing failures reject the build and relock", async () => {
    const { context, dependencies, status } = await harness();
    dependencies.run.mockImplementation(
      async (_file: string, args: string[]) => ({
        stdout: args[0] === "-extract" ? "com.cadence.meetingnotes" : "",
        stderr: args[0] === "-d" ? 'designated => cdhash H"0000"' : "",
      }),
    );
    await expect(hook(context, dependencies)).rejects.toThrow(
      "stable identity",
    );
    expect(status().relocked).toBe(true);
    dependencies.signAsync.mockRejectedValue(
      new Error("SECRET-PASSWORD synthetic subprocess failure"),
    );
    await expect(hook(context, dependencies)).rejects.toThrow(
      "existing identity was preserved",
    );
    expect(status().relocked).toBe(true);
  });
});
