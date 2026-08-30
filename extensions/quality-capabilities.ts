const QUALITY_CAPABILITY_EVENT = "jorgex:quality-capabilities";
const QUALITY_CAPABILITY_NAMESPACE = "jorgex.quality.capabilities";
const QUALITY_CAPABILITY_VERSION = 1;
const QUALITY_CAPABILITY_IDS = ["policy-guidance", "tool-approval", "external-verification"];

const policyEvidence = {
  source: "assets/system-prompt/AGENTS.md",
  version: "1",
};
const approvalEvidence = {
  source: "contract/jorgex-pi.v1.json",
  version: "1",
};

export const PI_QUALITY_CAPABILITIES_EVENT = QUALITY_CAPABILITY_EVENT;

export type PiQualityCapabilityFlags = {
  bootstrapReady?: boolean;
  policyPresent?: boolean;
  permissionReady?: boolean;
};

export type PiQualityCapabilityState = "prompt-only" | "manual" | "unavailable";

export type PiQualityCapability = {
  id: (typeof QUALITY_CAPABILITY_IDS)[number];
  state: PiQualityCapabilityState;
  reason: string;
  evidence?: {
    source: string;
    version: string;
  };
};

export type PiQualityCapabilityReport = {
  namespace: typeof QUALITY_CAPABILITY_NAMESPACE;
  version: typeof QUALITY_CAPABILITY_VERSION;
  runtime: "pi";
  capabilities: PiQualityCapability[];
};

export function reportPiQualityCapabilities(
  flags: PiQualityCapabilityFlags = {},
): PiQualityCapabilityReport {
  const bootstrapReady = flags.bootstrapReady === true;
  const policyPresent = flags.policyPresent === true;
  const permissionReady = flags.permissionReady === true;

  return {
    namespace: QUALITY_CAPABILITY_NAMESPACE,
    version: QUALITY_CAPABILITY_VERSION,
    runtime: "pi",
    capabilities: [
      policyCapability(bootstrapReady && policyPresent),
      approvalCapability(bootstrapReady && permissionReady),
      {
        id: "external-verification",
        state: "unavailable",
        reason: "External quality verification is owned by JorgeX Stack and is unavailable in Pi.",
      },
    ],
  };
}

function policyCapability(available: boolean): PiQualityCapability {
  return available
    ? {
        id: "policy-guidance",
        state: "prompt-only",
        reason: "The bundled JorgeX policy is available as guidance; Pi does not certify runtime enforcement.",
        evidence: { ...policyEvidence },
      }
    : {
        id: "policy-guidance",
        state: "unavailable",
        reason: "The bundled JorgeX policy is unavailable for this Pi bootstrap.",
      };
}

function approvalCapability(available: boolean): PiQualityCapability {
  return available
    ? {
        id: "tool-approval",
        state: "manual",
        reason: "Pi permission health is available, but tool approval remains a manual runtime action.",
        evidence: { ...approvalEvidence },
      }
    : {
        id: "tool-approval",
        state: "unavailable",
        reason: "The Pi permission service is unavailable or not ready for this session.",
      };
}
