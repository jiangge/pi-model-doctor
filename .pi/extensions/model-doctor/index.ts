import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerModelDoctorCommand } from "./src/command.ts";
import { ModelDoctor } from "./src/doctor.ts";
import type { DoctorPaths } from "./src/types.ts";

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

export function createModelDoctor(options: Partial<ConstructorParameters<typeof ModelDoctor>[0]> = {}): ModelDoctor {
  return new ModelDoctor({ paths: getDoctorPaths(), ...options });
}

export default function modelDoctorExtension(pi: ExtensionAPI): void {
  const doctor = createModelDoctor();
  registerModelDoctorCommand(pi, doctor);
}
