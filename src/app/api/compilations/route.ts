import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createCompilation, isCompilationBusy } from '@/pipeline/compile/run';
import { listCompilations } from '@/pipeline/compile/store';

export async function GET() {
  const all = await listCompilations();
  return NextResponse.json({
    compilations: all.map((c) => ({
      id: c.id,
      format: c.format,
      title: c.titles[0] || c.theme,
      theme: c.theme,
      clips: c.items.length,
      status: c.status,
      step: c.step,
      error: c.error ?? null,
      durationSec: c.output?.durationSec ?? null,
      hasVideo: Boolean(c.output),
      createdAt: c.createdAt,
      busy: isCompilationBusy(c.id),
    })),
  });
}

const Create = z.object({
  format: z.enum(['short', 'long']),
  keys: z.array(z.string()).max(40).optional(),
  theme: z
    .object({
      recipes: z.array(z.enum(['funny', 'chase', 'crash', 'clutch', 'rage', 'glitch', 'other'])).optional(),
      creator: z.string().max(80).optional(),
      sinceDays: z.number().positive().optional(),
      unusedOnly: z.boolean().optional(),
    })
    .optional(),
  count: z.number().int().min(2).max(30).optional(),
  title: z.string().max(100).optional(),
});

/** A new compilation from chosen clips ({ format, keys }) or a theme ({ format, theme, count }). */
export async function POST(req: Request) {
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Choose a format and some clips or a theme' }, { status: 400 });
  try {
    const c = await createCompilation(parsed.data);
    return NextResponse.json({ id: c.id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
