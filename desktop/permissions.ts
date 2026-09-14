export interface MediaPermissionDetails {
  isMainFrame?: boolean;
  requestingUrl?: string;
  securityOrigin?: string;
  embeddingOrigin?: string;
  mediaType?: string;
  mediaTypes?: readonly string[];
}

export interface MediaPermissionContext {
  expectedOrigin: string;
  rendererUrl: string;
  sameWebContents: boolean;
  requestingOrigin?: string;
  details: MediaPermissionDetails;
}

export interface MediaPermissionDecision {
  allowed: boolean;
  kind: "microphone" | "display-preflight" | "display-capture" | "denied";
  reason: string;
}

function matchesOrigin(url: string, expected: string) {
  try {
    return new URL(url).origin === expected;
  } catch {
    return false;
  }
}

export function isTrustedMediaRequester(
  context: MediaPermissionContext,
): boolean {
  if (
    !context.sameWebContents ||
    context.details.isMainFrame !== true ||
    !matchesOrigin(context.rendererUrl, context.expectedOrigin)
  )
    return false;
  // Empty origins occur during initial browser permission enumeration. Require
  // an actual request origin/URL; embeddingOrigin alone is not authorization.
  const origins = [
    context.requestingOrigin,
    context.details.requestingUrl,
    context.details.securityOrigin,
  ].filter((value): value is string => !!value);
  return (
    origins.length > 0 &&
    origins.every((value) => matchesOrigin(value, context.expectedOrigin))
  );
}

const denied = (reason: string): MediaPermissionDecision => ({
  allowed: false,
  kind: "denied",
  reason,
});

export function checkMediaPermission(
  permission: string,
  context: MediaPermissionContext,
): boolean {
  if (!isTrustedMediaRequester(context)) return false;
  // Generic checks do not grant a capture. Explicit requests below decide it.
  if (permission === "media") return context.details.mediaType === "audio";
  return permission === "display-capture";
}

export function decideMediaPermissionRequest(
  permission: string,
  context: MediaPermissionContext,
): MediaPermissionDecision {
  if (!isTrustedMediaRequester(context))
    return denied("untrusted-renderer-or-frame");
  if (permission === "display-capture")
    return {
      allowed: true,
      kind: "display-capture",
      reason: "trusted-display-request",
    };
  if (permission !== "media") return denied("unsupported-permission");
  const mediaTypes = context.details.mediaTypes ?? [];
  if (mediaTypes.some((type) => type !== "audio"))
    return denied("camera-or-unsupported-media");
  if (mediaTypes.length)
    return {
      allowed: true,
      kind: "microphone",
      reason: "trusted-microphone-request",
    };
  // Electron 44 reports getDisplayMedia's prerequisite as permission="media"
  // with mediaTypes=[]. This only admits its display handler, which separately
  // validates the requesting frame, user gesture and requested system audio.
  return {
    allowed: true,
    kind: "display-preflight",
    reason: "trusted-empty-media-display-preflight",
  };
}

export function oncePermissionReply<T>(
  callback: (value: T) => void,
  onError?: () => void,
) {
  let answered = false;
  return (value: T) => {
    if (answered) return;
    answered = true;
    try {
      callback(value);
    } catch {
      onError?.();
    }
  };
}

export async function answerMediaPermissionRequest(options: {
  permission: string;
  context: () => MediaPermissionContext;
  requestMicrophone: () => Promise<boolean>;
  callback: (allowed: boolean) => void;
  log?: (decision: MediaPermissionDecision) => void;
}) {
  const reply = oncePermissionReply(options.callback, () =>
    options.log?.(denied("permission-callback-unavailable")),
  );
  try {
    let decision = decideMediaPermissionRequest(
      options.permission,
      options.context(),
    );
    if (decision.kind === "microphone") {
      // Always call the OS request API for each trusted microphone attempt.
      // macOS itself resolves existing grants/denials without repeated prompts.
      const granted = await options.requestMicrophone();
      decision = !granted
        ? denied("microphone-os-denied")
        : !isTrustedMediaRequester(options.context())
          ? denied("renderer-changed-during-os-request")
          : decision;
    }
    options.log?.(decision);
    reply(decision.allowed);
  } catch {
    options.log?.(denied("microphone-os-request-failed"));
    reply(false);
  }
}
