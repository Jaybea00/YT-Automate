import type { Metadata } from 'next';
import { getSupabaseServerClient } from '@/lib/supabase/server';
import { VideoSteps } from '@/components/shell/video-steps';

/** Every page of a video shares its title, status and step bar. */
async function loadVideo(id: string): Promise<{ title: string; status: string | null }> {
  if (!/^[\w-]+$/.test(id)) return { title: 'Video', status: null };
  try {
    const { data } = await getSupabaseServerClient().from('videos').select('title, topic, status').eq('id', id).maybeSingle();
    return { title: String(data?.title || data?.topic || 'Untitled video'), status: (data?.status as string) ?? null };
  } catch {
    return { title: 'Video', status: null };
  }
}

export async function generateMetadata({ params }: LayoutProps<'/videos/[id]'>): Promise<Metadata> {
  const { id } = await params;
  return { title: (await loadVideo(id)).title };
}

export default async function VideoLayout({ children, params }: LayoutProps<'/videos/[id]'>) {
  const { id } = await params;
  const video = await loadVideo(id);
  return (
    <>
      <VideoSteps videoId={id} title={video.title} status={video.status} />
      {children}
    </>
  );
}
