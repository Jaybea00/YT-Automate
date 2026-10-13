/** Binding/config option keys that steer the pipeline and must not be sent to TTS servers. */
const PIPELINE_ONLY_KEYS = ['wordTimestamps', 'styleDirection'];

export function serverOptions(options: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(options ?? {}) };
  for (const key of PIPELINE_ONLY_KEYS) delete out[key];
  return out;
}
