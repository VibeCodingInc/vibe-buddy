import { createHash } from "node:crypto";

export const EVIDENCE_SCHEMA = "buddy-update-gauntlet/v1";
export const STANDARD_APP_PATH = "/Applications/Vibe Buddy.app";
export const REQUIRED_SCENARIOS = ["immediate", "delayed-wake"];
export const MACOS_TAR_METADATA_MARKERS = ["SCHILY.xattr", "LIBARCHIVE.xattr"];
export const REQUIRED_FINISH_CHECKS = [
  "installedTargetVersion",
  "standardApplicationsPath",
  "bundleIdentifierPreserved",
  "codeSignatureValid",
  "signingTeamPreserved",
  "gatekeeperAccepted",
  "exactlyOneInstalledProcess",
  "appRelaunched",
  "authReadableAndValid",
  "signedInHandlePreserved",
  "authTokenPreserved",
  "localStorageReadable",
  "localHandlePreserved",
  "presencePreferencesPreserved",
  "noNewUpdaterFailure",
  "delayedWakeProved",
];

export function stableStringify(value) {
  if (["undefined", "function", "symbol"].includes(typeof value)) return undefined;
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => [key, stableStringify(value[key])])
    .filter(([, serialized]) => serialized !== undefined)
    .map(([key, serialized]) => `${JSON.stringify(key)}:${serialized}`)
    .join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createMacOSMetadataMarkerScanner(markers = MACOS_TAR_METADATA_MARKERS) {
  const encoded = markers.map((marker) => ({ marker, bytes: Buffer.from(marker, "utf8") }));
  const overlap = Math.max(...encoded.map(({ bytes }) => bytes.length), 1) - 1;
  const findings = new Set();
  let tail = Buffer.alloc(0);

  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const searchable = tail.length ? Buffer.concat([tail, bytes]) : bytes;
      for (const marker of encoded) {
        if (searchable.includes(marker.bytes)) findings.add(marker.marker);
      }
      tail = overlap > 0 ? searchable.subarray(Math.max(0, searchable.length - overlap)) : Buffer.alloc(0);
    },
    findings() {
      return [...findings].sort();
    },
  };
}

export function prohibitedMacOSMetadataEntries(entries) {
  return entries.filter((entry) => {
    const segments = String(entry).replace(/^\.\//, "").split("/");
    return segments.some(
      (segment) =>
        segment === "__MACOSX" ||
        segment === ".DS_Store" ||
        segment === ".AppleDouble" ||
        segment.startsWith("._"),
    );
  });
}

export function normalizeUpdaterManifest(manifest, target = "darwin-aarch64") {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest is not a JSON object");
  }
  const platform = manifest.platforms?.[target] ?? manifest;
  if (
    typeof manifest.version !== "string" ||
    typeof platform?.url !== "string" ||
    typeof platform?.signature !== "string"
  ) {
    throw new Error(`manifest omitted version or ${target} url/signature`);
  }
  return {
    version: manifest.version,
    notes: typeof manifest.notes === "string" ? manifest.notes : null,
    pubDate: typeof manifest.pub_date === "string" ? manifest.pub_date : null,
    url: platform.url,
    signature: platform.signature,
  };
}

export function hashEvidenceEvent(event) {
  const unsigned = { ...event };
  delete unsigned.hash;
  return sha256(stableStringify(unsigned));
}

export function createEvidenceEvent({
  runId,
  type,
  payload,
  previous,
  at = new Date().toISOString(),
}) {
  const event = {
    schema: EVIDENCE_SCHEMA,
    runId,
    seq: previous ? previous.seq + 1 : 0,
    at,
    type,
    previousHash: previous ? previous.hash : null,
    payload,
  };
  return { ...event, hash: hashEvidenceEvent(event) };
}

export function verifyEvidenceChain(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("evidence chain is empty");
  }

  let previous = null;
  for (const event of events) {
    if (event.schema !== EVIDENCE_SCHEMA) {
      throw new Error(`unsupported evidence schema at sequence ${event.seq}`);
    }
    if (event.seq !== (previous ? previous.seq + 1 : 0)) {
      throw new Error(`non-contiguous evidence sequence at ${event.seq}`);
    }
    if (event.runId !== events[0].runId) {
      throw new Error(`run id changed at sequence ${event.seq}`);
    }
    if (event.previousHash !== (previous ? previous.hash : null)) {
      throw new Error(`broken evidence link at sequence ${event.seq}`);
    }
    if (event.hash !== hashEvidenceEvent(event)) {
      throw new Error(`evidence hash mismatch at sequence ${event.seq}`);
    }
    previous = event;
  }
  return true;
}

export function summarizeEvidenceRun(events) {
  verifyEvidenceChain(events);
  const starts = events.filter((event) => event.type === "start");
  const wakes = events.filter((event) => event.type === "wake");
  const finishes = events.filter((event) => event.type === "finish");
  if (starts.length !== 1 || starts[0].seq !== 0) throw new Error("evidence must begin with exactly one start event");
  if (wakes.length > 1) throw new Error("evidence contains duplicate wake events");
  if (finishes.length > 1) throw new Error("evidence contains duplicate finish events");
  if (events.some((event) => !["start", "wake", "finish"].includes(event.type))) {
    throw new Error("evidence contains an unknown event type");
  }
  if (finishes.length === 1 && events.at(-1) !== finishes[0]) {
    throw new Error("finish must be the last evidence event");
  }

  const start = starts[0];
  const payload = start.payload ?? {};
  if (!REQUIRED_SCENARIOS.includes(payload.scenario)) throw new Error("start has an invalid scenario");
  if (payload.cleanEnvironment !== true || payload.offerVisible !== true) {
    throw new Error("start is missing clean-environment or visible-offer attestation");
  }
  if (payload.before?.app?.appPath !== STANDARD_APP_PATH) throw new Error("start did not use the standard app path");
  if (!payload.before?.machineFingerprint) throw new Error("start is missing the hardware fingerprint");
  if (!payload.before?.app?.version || !payload.manifest?.version) throw new Error("start is missing source or target version");
  if (payload.artifact?.metadata?.clean !== true) {
    throw new Error("artifact lacks a passing macOS metadata inspection");
  }
  if (payload.artifact?.bundle?.version !== payload.manifest.version) {
    throw new Error("artifact version does not match the manifest target");
  }
  if (payload.scenario === "immediate" && wakes.length !== 0) {
    throw new Error("an immediate run contains wake evidence");
  }

  const finish = finishes[0];
  let passed = false;
  if (finish?.payload?.passed === true) {
    const checks = finish.payload.checks ?? {};
    const missing = REQUIRED_FINISH_CHECKS.filter((check) => checks[check] !== true);
    if (missing.length) throw new Error(`passing finish omitted checks: ${missing.join(", ")}`);
    if (payload.scenario === "delayed-wake" && wakes.length !== 1) {
      throw new Error("passing delayed-wake run has no wake event");
    }
    passed = true;
  }

  return {
    runId: start.runId,
    machine: payload.machine,
    machineFingerprint: payload.before.machineFingerprint,
    scenario: payload.scenario,
    sourceVersion: payload.before.app.version,
    targetVersion: payload.manifest.version,
    cleanEnvironment: payload.cleanEnvironment,
    appPath: payload.before.app.appPath,
    passed,
    evidenceValid: true,
  };
}

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`invalid version comparison: ${left}, ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function isConsecutivePatch(sourceVersion, targetVersion) {
  const source = parseVersion(sourceVersion);
  const target = parseVersion(targetVersion);
  return Boolean(
    source &&
      target &&
      source[0] === target[0] &&
      source[1] === target[1] &&
      target[2] === source[2] + 1,
  );
}

const PMSET_DATE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+(Sleep|Wake)\s/;

export function parseSleepWakePairs(log) {
  const pairs = [];
  let pendingSleep = null;
  for (const line of String(log).split("\n")) {
    const match = PMSET_DATE.exec(line.trim());
    if (!match) continue;
    const at = new Date(match[1].replace(" ", "T").replace(/ ([+-]\d{4})$/, "$1"));
    if (Number.isNaN(at.getTime())) continue;
    if (match[2] === "Sleep") {
      pendingSleep = { at: at.toISOString(), epochMs: at.getTime(), line: line.trim() };
    } else if (pendingSleep) {
      pairs.push({
        sleepAt: pendingSleep.at,
        wakeAt: at.toISOString(),
        durationSeconds: Math.round((at.getTime() - pendingSleep.epochMs) / 1000),
        sleepLine: pendingSleep.line,
        wakeLine: line.trim(),
      });
      pendingSleep = null;
    }
  }
  return pairs;
}

export function qualifyingSleepWakePairs(
  pairs,
  {
    startedAt,
    observedAt = Date.now(),
    minimumSleepSeconds = 120,
    minimumWakeAgeSeconds = 30,
  },
) {
  const startMs = typeof startedAt === "number" ? startedAt : Date.parse(startedAt);
  const observedMs = typeof observedAt === "number" ? observedAt : Date.parse(observedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(observedMs)) return [];
  return pairs.filter(
    (pair) =>
      Date.parse(pair.sleepAt) >= startMs &&
      pair.durationSeconds >= minimumSleepSeconds &&
      observedMs - Date.parse(pair.wakeAt) >= minimumWakeAgeSeconds * 1000,
  );
}

function transitionKey(run) {
  return `${run.sourceVersion}->${run.targetVersion}`;
}

function transitionSort(left, right) {
  return compareVersions(left.split("->")[0], right.split("->")[0]);
}

export function evaluateG4(runs) {
  const candidates = runs.filter(
    (run) =>
      run.passed === true &&
      run.evidenceValid === true &&
      run.cleanEnvironment === true &&
      typeof run.machine === "string" &&
      run.machine.length > 0 &&
      typeof run.machineFingerprint === "string" &&
      run.machineFingerprint.length > 0 &&
      run.appPath === STANDARD_APP_PATH &&
      REQUIRED_SCENARIOS.includes(run.scenario) &&
      isConsecutivePatch(run.sourceVersion, run.targetVersion),
  );
  const labelsByFingerprint = new Map();
  for (const run of candidates) {
    const labels = labelsByFingerprint.get(run.machineFingerprint) ?? new Set();
    labels.add(run.machine);
    labelsByFingerprint.set(run.machineFingerprint, labels);
  }
  const inconsistentFingerprints = new Set(
    [...labelsByFingerprint].filter(([, labels]) => labels.size !== 1).map(([fingerprint]) => fingerprint),
  );
  const eligible = candidates.filter((run) => !inconsistentFingerprints.has(run.machineFingerprint));

  const byTransition = new Map();
  for (const run of eligible) {
    const key = transitionKey(run);
    const existing = byTransition.get(key) ?? [];
    existing.push(run);
    byTransition.set(key, existing);
  }

  const transitionKeys = [...byTransition.keys()].sort(transitionSort);
  for (let index = 0; index < transitionKeys.length - 1; index += 1) {
    const firstKey = transitionKeys[index];
    const secondKey = transitionKeys[index + 1];
    const firstRuns = byTransition.get(firstKey);
    const secondRuns = byTransition.get(secondKey);
    if (firstRuns[0].targetVersion !== secondRuns[0].sourceVersion) continue;

    const firstMachines = new Set(firstRuns.map((run) => run.machineFingerprint));
    const commonFingerprints = [
      ...new Set(secondRuns.map((run) => run.machineFingerprint)),
    ].filter((fingerprint) => firstMachines.has(fingerprint));
    if (commonFingerprints.length < 2) continue;

    for (let left = 0; left < commonFingerprints.length - 1; left += 1) {
      for (let right = left + 1; right < commonFingerprints.length; right += 1) {
        const pair = [commonFingerprints[left], commonFingerprints[right]];
        const selected = [...firstRuns, ...secondRuns].filter((run) =>
          pair.includes(run.machineFingerprint),
        );
        const scenariosByTransition = new Map(
          [firstKey, secondKey].map((key) => [
            key,
            new Set(selected.filter((run) => transitionKey(run) === key).map((run) => run.scenario)),
          ]),
        );
        const scenariosCovered = [...scenariosByTransition.values()].every((scenarios) =>
          REQUIRED_SCENARIOS.every((scenario) => scenarios.has(scenario)),
        );
        if (!scenariosCovered) continue;

        return {
          green: true,
          reasons: [],
          matrix: {
            machines: pair
              .map((fingerprint) => selected.find((run) => run.machineFingerprint === fingerprint).machine)
              .sort(),
            transitions: [firstKey, secondKey],
            scenarios: REQUIRED_SCENARIOS,
            runIds: selected.map((run) => run.runId).sort(),
          },
        };
      }
    }
  }

  const reasons = [];
  const machineFingerprints = new Set(eligible.map((run) => run.machineFingerprint));
  const machines = new Set(eligible.map((run) => run.machine));
  if (machineFingerprints.size < 2) reasons.push("fewer than two clean Macs have qualifying successful runs");
  if (transitionKeys.length < 2) reasons.push("fewer than two qualifying release transitions have passed");
  if (transitionKeys.length >= 2) {
    reasons.push("no two consecutive release transitions have a complete common two-Mac matrix");
  }
  const missingScenario = transitionKeys.some((key) => {
    const scenarios = new Set(byTransition.get(key).map((run) => run.scenario));
    return REQUIRED_SCENARIOS.some((scenario) => !scenarios.has(scenario));
  });
  if (missingScenario) reasons.push("at least one transition lacks immediate or delayed-wake evidence");
  if (runs.some((run) => run.passed !== true)) reasons.push("failed or incomplete runs never count as delivery");
  if (inconsistentFingerprints.size > 0) reasons.push("a hardware fingerprint was reused under inconsistent machine labels");
  if (reasons.length === 0) reasons.push("the required two-Mac, two-transition matrix is incomplete");

  return {
    green: false,
    reasons,
    matrix: {
      machines: [...machines].sort(),
      transitions: transitionKeys,
      scenarios: REQUIRED_SCENARIOS,
      runIds: eligible.map((run) => run.runId).sort(),
    },
  };
}
