/** Packaging types, safe to use in the browser. */

export interface PackageOption {
  title: string;
  /** The one image the thumbnail is built on. */
  thumbnail_image: string;
  /** 2-4 words on the thumbnail, or "" for none. */
  thumbnail_text: string;
  /** What the viewer is promised: the question the video answers. */
  promise: string;
  angle: string;
}

export interface Packaging {
  options: PackageOption[];
  /** Index of the option the script is written to deliver. */
  chosen: number;
}

/** The chosen option, or null when there's no valid choice. */
export function chosenPackage(packaging: Packaging | null | undefined): PackageOption | null {
  if (!packaging?.options?.length) return null;
  return packaging.options[packaging.chosen] ?? packaging.options[0];
}

/** Keeps the chosen title as the first title option, so approval and Publish start from it. */
export function leadWithPackageTitle(titleOptions: string[], pkg: PackageOption | null | undefined): string[] {
  if (!pkg?.title.trim()) return titleOptions;
  return [pkg.title, ...titleOptions.filter((t) => t.trim().toLowerCase() !== pkg.title.trim().toLowerCase())];
}

/** Packaging as sent back from the outline page: valid options and a chosen index in range. */
export function sanitizePackaging(value: unknown): Packaging | null {
  const v = value as Partial<Packaging> | null | undefined;
  if (!v || !Array.isArray(v.options)) return null;
  const text = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const options = v.options
    .map((o) => ({
      title: text(o?.title, 100),
      thumbnail_image: text(o?.thumbnail_image, 300),
      thumbnail_text: text(o?.thumbnail_text, 60),
      promise: text(o?.promise, 400),
      angle: text(o?.angle, 30),
    }))
    .filter((o) => o.title)
    .slice(0, 6);
  if (options.length === 0) return null;
  const chosen = Number.isInteger(v.chosen) && v.chosen! >= 0 && v.chosen! < options.length ? v.chosen! : 0;
  return { options, chosen };
}
