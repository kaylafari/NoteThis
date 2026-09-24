const path = require("node:path");
const { lstat, realpath } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");

/** electron-builder afterSign hook; dependencies are injectable for no-keychain tests. */
async function signLocalMac(context, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  if (platform !== "darwin" || context.electronPlatformName !== "darwin")
    return;
  const signing =
    dependencies.signing ||
    (await import(
      pathToFileURL(path.join(__dirname, "local-signing.mjs")).href
    ));
  const run = (file, args, label) =>
    signing.runSigningCommand(file, args, label, dependencies.run);
  const app = path.resolve(context.appOutDir, "NoteThis.app");
  const info = path.join(app, "Contents", "Info.plist");
  const entitlements = path.resolve(
    context.packager.projectDir,
    "desktop",
    "entitlements.mac.plist",
  );
  if (context.packager.appInfo.productFilename !== "NoteThis")
    throw new Error("Local signing hook only signs the NoteThis app bundle.");
  const appStat = await lstat(app);
  if (
    !appStat.isDirectory() ||
    appStat.isSymbolicLink() ||
    (await realpath(app)) !== app
  )
    throw new Error(
      "Local signing refuses an unexpected or redirected app bundle.",
    );
  const bundleId = String(
    (
      await run(
        "/usr/bin/plutil",
        ["-extract", "CFBundleIdentifier", "raw", "-o", "-", info],
        "read app bundle identifier",
      )
    ).stdout,
  ).trim();
  if (bundleId !== "com.cadence.meetingnotes")
    throw new Error(
      "Local signing refuses a bundle other than com.cadence.meetingnotes.",
    );
  const identity = await signing.getLocalSigningIdentity({ create: false });
  const signAsync =
    dependencies.signAsync || require("@electron/osx-sign").signAsync;
  await signing.withUnlockedLocalSigningIdentity(identity, async (verified) => {
    try {
      await signAsync({
        app,
        platform: "darwin",
        identity: verified.fingerprint,
        keychain: verified.keychainPath,
        identityValidation: false,
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: () => ({
          entitlements,
          hardenedRuntime: true,
          timestamp: "none",
        }),
      });
    } catch {
      throw new Error(
        "Local NoteThis signing failed. The existing identity was preserved; inspect the dedicated keychain and app bundle before retrying.",
      );
    }
    await run(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", app],
      "verify app and nested signatures",
    );
    const requirement = await run(
      "/usr/bin/codesign",
      ["-d", "-r-", app],
      "inspect the stable designated requirement",
    );
    const text = `${requirement.stdout || ""}\n${requirement.stderr || ""}`;
    const anchor = new RegExp(
      `(?:anchor\\s*(?:=\\s*)?H"|certificate\\s+(?:leaf|0)\\s*(?:=\\s*)?H")${verified.fingerprint}"`,
      "i",
    );
    if (
      /\bcdhash\b/i.test(text) ||
      !anchor.test(text) ||
      !text.includes("com.cadence.meetingnotes")
    )
      throw new Error(
        "Local signature does not use the saved certificate as its stable identity. Refusing this build.",
      );
  });
}
module.exports = signLocalMac;
module.exports.signLocalMac = signLocalMac;
