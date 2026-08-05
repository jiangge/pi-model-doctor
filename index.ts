import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerModelDoctorCommand } from "./src/command.ts";
import { ModelDoctor } from "./src/doctor.ts";
import type { DoctorPaths } from "./src/types.ts";

const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_JITTER_RATIO = 0.1;
const MAX_REFRESH_JITTER_MS = 5 * 60 * 1000;

export function getDoctorPaths(): DoctorPaths {
  const doctorDir = process.env.PI_MODEL_DOCTOR_DIR ?? join(homedir(), ".pi", "model-doctor");
  return {
    modelsPath: process.env.PI_MODEL_DOCTOR_MODELS_PATH ?? join(getAgentDir(), "models.json"),
    doctorDir,
    modelsCachePath: join(doctorDir, "models-cache.json"),
    providersCachePath: join(doctorDir, "providers-cache.json"),
    policiesCachePath: join(doctorDir, "policies-cache.json"),
  };
}

export function getModelDoctorRefreshIntervalMs(): number {
  const configured = process.env.PI_MODEL_DOCTOR_REFRESH_INTERVAL_MS;
  if (configured === undefined) return DEFAULT_REFRESH_INTERVAL_MS;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REFRESH_INTERVAL_MS;
  return parsed;
}

export function getModelDoctorRefreshJitterMs(intervalMs = getModelDoctorRefreshIntervalMs()): number {
  const configured = process.env.PI_MODEL_DOCTOR_REFRESH_JITTER_MS;
  if (configured !== undefined) {
    const parsed = Number(configured);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return Math.min(MAX_REFRESH_JITTER_MS, Math.floor(intervalMs * DEFAULT_REFRESH_JITTER_RATIO));
}

export function createModelDoctor(options: Partial<ConstructorParameters<typeof ModelDoctor>[0]> = {}): ModelDoctor {
  return new ModelDoctor({ paths: getDoctorPaths(), ...options });
}

export function registerModelDoctorLifecycle(pi: ExtensionAPI, doctor: ModelDoctor): void {
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshGeneration = 0;
  const stopRefreshTimer = (): void => {
    refreshGeneration += 1;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    stopRefreshTimer();
    const intervalMs = getModelDoctorRefreshIntervalMs();
    if (intervalMs === 0) return;
    const generation = refreshGeneration;
    const scheduleRefresh = (): void => {
      if (generation !== refreshGeneration) return;
      const jitterMs = getModelDoctorRefreshJitterMs(intervalMs);
      const offset = jitterMs > 0 ? Math.floor(Math.random() * (jitterMs * 2 + 1)) - jitterMs : 0;
      refreshTimer = setTimeout(() => {
        if (generation !== refreshGeneration) return;
        void doctor.refresh(true, true).then((result) => {
          if (result.warning && generation === refreshGeneration) {
            ctx.ui.notify("model-doctor: background catalog refresh used a stale cache; existing configuration was not changed.", "warning");
          }
        }).catch(() => {
          if (generation === refreshGeneration) {
            ctx.ui.notify("model-doctor: background catalog refresh was unavailable; existing configuration was not changed.", "warning");
          }
        }).finally(() => {
          if (generation === refreshGeneration) scheduleRefresh();
        });
      }, Math.max(1, intervalMs + offset));
      const timer = refreshTimer as unknown as { unref?: () => void };
      timer.unref?.();
    };
    scheduleRefresh();
  });

  pi.on("session_shutdown", () => {
    stopRefreshTimer();
  });
}

export default function modelDoctorExtension(pi: ExtensionAPI): void {
  const doctor = createModelDoctor();
  registerModelDoctorCommand(pi, doctor);
  registerModelDoctorLifecycle(pi, doctor);
}
