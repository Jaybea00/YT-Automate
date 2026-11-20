import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listLibrary } from '@/pipeline/compile/library';
import { loadChannelProfile } from '@/pipeline/channel/store';
import { composeCompilationDescription, writeCompilationUploadInfo } from '@/pipeline/compile/package';
import { enqueueCompilation, isCompilationBusy, itemFromLibrary, type CompilationRunFrom } from '@/pipeline/compile/run';
import { compilationDir, deleteCompilation, loadCompilation, updateCompilation } from '@/pipeline/compile/store';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  const c = await loadCompilation(id);
  if (!c) return NextResponse.json({ error: 'Compilation not found' }, { status: 404 });
  return NextResponse.json({ compilation: c, busy: isCompilationBusy(id), uploadDescription: composeCompilationDescription(c, await loadChannelProfile()) });
}

const Edit = z.object({
  theme: z.string().max(100).optional(),
  hook: z.string().max(120).optional(),
  intro: z.string().max(400).optional(),
  outro: z.string().max(300).optional(),
  titles: z.array(z.string().max(100)).max(8).optional(),
  description: z.string().max(4000).optional(),
  tags: z.array(z.string().max(60)).max(30).optional(),
  options: z
    .object({ captions: z.boolean(), cleanCaptions: z.boolean(), nameCards: z.boolean(), voiceover: z.boolean(), crop: z.boolean(), voice: z.string().max(80) })
    .partial()
    .optional(),
  /** The clips in running order; keys not in the compilation yet are added from the library. */
  items: z
    .array(z.object({ key: z.string(), start: z.number().min(0).optional(), end: z.number().min(0).optional(), label: z.string().max(80).optional(), line: z.string().max(200).optional() }))
    .max(40)
    .optional(),
});

/** Saves edits (they take effect on the next render). */
export async function PATCH(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const parsed = Edit.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid edit' }, { status: 400 });
  const current = await loadCompilation(id);
  if (!current) return NextResponse.json({ error: 'Compilation not found' }, { status: 404 });
  if (isCompilationBusy(id)) return NextResponse.json({ error: 'The compilation is still being made' }, { status: 409 });
  const edit = parsed.data;
  if (edit.items && edit.items.length < 2) return NextResponse.json({ error: 'A compilation needs at least 2 clips' }, { status: 400 });

  const library = edit.items?.some((i) => !current.items.find((x) => x.key === i.key)) ? await listLibrary() : [];
  const updated = await updateCompilation(id, (c) => {
    if (edit.theme !== undefined) c.theme = edit.theme.trim();
    if (edit.hook !== undefined) c.hook = edit.hook.trim();
    if (edit.intro !== undefined) c.intro = edit.intro.trim();
    if (edit.outro !== undefined) c.outro = edit.outro.trim();
    if (edit.titles) c.titles = edit.titles.map((t) => t.trim()).filter(Boolean);
    if (edit.description !== undefined) c.description = edit.description.trim();
    if (edit.tags) c.tags = edit.tags.map((t) => t.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
    if (edit.options) c.options = { ...c.options, ...edit.options };
    if (edit.items) {
      c.items = edit.items.flatMap((e) => {
        const existing = c.items.find((x) => x.key === e.key);
        const fromLibrary = existing ? null : library.find((l) => l.key === e.key);
        const base = existing ?? (fromLibrary ? itemFromLibrary(fromLibrary) : null);
        if (!base) return [];
        const max = c.analysis[e.key]?.durationSec ?? base.end;
        const start = Math.min(Math.max(0, e.start ?? base.start), Math.max(0, max - 1));
        const end = Math.min(max, Math.max(start + 1, e.end ?? base.end));
        return [{ ...base, start, end, label: e.label?.trim() ?? base.label, line: e.line?.trim() ?? base.line }];
      });
    }
  });
  const channel = await loadChannelProfile();
  if (updated.output) await writeCompilationUploadInfo(compilationDir(id), updated, channel);
  return NextResponse.json({ compilation: updated, uploadDescription: composeCompilationDescription(updated, channel) });
}

/** Makes it again: { from: "render" } after edits, "script" for fresh words, "all" to also re-fit the clips. */
export async function POST(req: Request, context: RouteContext) {
  const { id } = await context.params;
  const body = (await req.json().catch(() => ({}))) as { from?: string };
  const from: CompilationRunFrom = body.from === 'all' || body.from === 'script' ? body.from : 'render';
  if (!(await loadCompilation(id))) return NextResponse.json({ error: 'Compilation not found' }, { status: 404 });
  if (isCompilationBusy(id)) return NextResponse.json({ error: 'The compilation is already being made' }, { status: 409 });
  await updateCompilation(id, (c) => {
    c.status = 'queued';
    c.step = 'Waiting to start';
    delete c.error;
  });
  enqueueCompilation(id, from);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, context: RouteContext) {
  const { id } = await context.params;
  if (isCompilationBusy(id)) return NextResponse.json({ error: 'The compilation is still being made' }, { status: 409 });
  return (await deleteCompilation(id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Compilation not found' }, { status: 404 });
}
