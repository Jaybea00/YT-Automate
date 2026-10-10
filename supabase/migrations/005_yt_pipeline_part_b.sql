-- 005_yt_pipeline_part_b.sql
-- Seeds default provider configurations and stage bindings for:
-- 1. script -> Gemini (using existing/new Vault secret)
-- 2. tts -> ElevenLabs
-- 3. stock -> Pexels (prep for Part C)
--
-- Replace placeholders before running:
--   '<YOUR_GEMINI_VAULT_SECRET_UUID>'
--   '<YOUR_ELEVENLABS_VAULT_SECRET_UUID>'
--   '<YOUR_ELEVENLABS_VOICE_ID>' (e.g. '21m00Tcm4TlvDq8ikWAM' or Rachel)
--   '<YOUR_PEXELS_VAULT_SECRET_UUID>'

-- 1. Insert or update Gemini LLM provider config
insert into yt_provider_configs (id, kind, provider, label, default_model, secret_id, options, is_active)
values (
  '11111111-1111-1111-1111-111111111101',
  'llm',
  'gemini',
  'Google Gemini Flash',
  'gemini-3.8-flash',
  '<YOUR_GEMINI_VAULT_SECRET_UUID>'::uuid,
  '{"temperature": 0.7}'::jsonb,
  true
)
on conflict (id) do update set
  provider = excluded.provider,
  label = excluded.label,
  default_model = excluded.default_model,
  secret_id = excluded.secret_id,
  options = excluded.options,
  is_active = excluded.is_active,
  updated_at = now();

-- 2. Insert or update ElevenLabs TTS provider config
insert into yt_provider_configs (id, kind, provider, label, default_model, secret_id, options, is_active)
values (
  '11111111-1111-1111-1111-111111111102',
  'tts',
  'elevenlabs',
  'ElevenLabs Main',
  'eleven_multilingual_v2',
  '<YOUR_ELEVENLABS_VAULT_SECRET_UUID>'::uuid,
  '{"voiceId": "<YOUR_ELEVENLABS_VOICE_ID>"}'::jsonb,
  true
)
on conflict (id) do update set
  provider = excluded.provider,
  label = excluded.label,
  default_model = excluded.default_model,
  secret_id = excluded.secret_id,
  options = excluded.options,
  is_active = excluded.is_active,
  updated_at = now();

-- 3. Insert or update Pexels Stock provider config (for Part C)
insert into yt_provider_configs (id, kind, provider, label, secret_id, options, is_active)
values (
  '11111111-1111-1111-1111-111111111103',
  'stock',
  'pexels',
  'Pexels Stock Video',
  '<YOUR_PEXELS_VAULT_SECRET_UUID>'::uuid,
  '{"orientation": "landscape"}'::jsonb,
  true
)
on conflict (id) do update set
  provider = excluded.provider,
  label = excluded.label,
  secret_id = excluded.secret_id,
  options = excluded.options,
  is_active = excluded.is_active,
  updated_at = now();

-- 4. Bind 'script' stage to Gemini
insert into yt_stage_bindings (stage, provider_config_id, model, options, max_retries)
values (
  'script',
  '11111111-1111-1111-1111-111111111101',
  'gemini-3.8-flash',
  '{}'::jsonb,
  2
)
on conflict (stage) do update set
  provider_config_id = excluded.provider_config_id,
  model = excluded.model,
  options = excluded.options,
  max_retries = excluded.max_retries,
  updated_at = now();

-- 5. Bind 'tts' stage to ElevenLabs
insert into yt_stage_bindings (stage, provider_config_id, model, options, max_retries)
values (
  'tts',
  '11111111-1111-1111-1111-111111111102',
  'eleven_multilingual_v2',
  '{"voiceId": "<YOUR_ELEVENLABS_VOICE_ID>"}'::jsonb,
  2
)
on conflict (stage) do update set
  provider_config_id = excluded.provider_config_id,
  model = excluded.model,
  options = excluded.options,
  max_retries = excluded.max_retries,
  updated_at = now();
