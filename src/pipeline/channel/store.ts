import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeChannelProfile, type ChannelProfile } from '@/lib/channel/profile';
import { writeFileAtomic } from '../utils/atomic-write';

/** The channel profile, kept with other local settings under storage/. */
export function channelFile(): string {
  return path.join(process.cwd(), 'storage', 'settings', 'channel.json');
}

/** The saved profile, or the defaults when there is none yet. */
export async function loadChannelProfile(file = channelFile()): Promise<ChannelProfile> {
  try {
    return normalizeChannelProfile(JSON.parse(await fs.readFile(file, 'utf-8')));
  } catch {
    return normalizeChannelProfile({});
  }
}

export async function saveChannelProfile(value: unknown, file = channelFile()): Promise<ChannelProfile> {
  const clean = normalizeChannelProfile(value);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(clean, null, 2));
  return clean;
}
