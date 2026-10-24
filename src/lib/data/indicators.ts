/**
 * World Bank indicators a chart may draw from real figures (free, open data, CC BY 4.0). Kept to
 * well-filled, widely understood series so a chart rarely comes up empty.
 */
export interface Indicator {
  code: string;
  /** How the chart titles it. */
  label: string;
  /** The unit line under the title. */
  unit: string;
  /** Divide raw values by this for display (e.g. billions). */
  scale?: number;
}

export const INDICATORS: Indicator[] = [
  { code: 'NY.GDP.MKTP.CD', label: 'GDP', unit: 'US$ billions', scale: 1e9 },
  { code: 'NY.GDP.PCAP.CD', label: 'GDP per person', unit: 'US$' },
  { code: 'NY.GDP.MKTP.KD.ZG', label: 'GDP growth', unit: '% a year' },
  { code: 'NY.GNP.PCAP.CD', label: 'Income per person (GNI)', unit: 'US$' },
  { code: 'FP.CPI.TOTL.ZG', label: 'Inflation', unit: '% a year' },
  { code: 'SL.UEM.TOTL.ZS', label: 'Unemployment', unit: '% of the labour force' },
  { code: 'GC.DOD.TOTL.GD.ZS', label: 'Government debt', unit: '% of GDP' },
  { code: 'NE.EXP.GNFS.ZS', label: 'Exports', unit: '% of GDP' },
  { code: 'BX.KLT.DINV.CD.WD', label: 'Foreign investment in', unit: 'US$ billions', scale: 1e9 },
  { code: 'SP.POP.TOTL', label: 'Population', unit: 'millions', scale: 1e6 },
  { code: 'SP.DYN.LE00.IN', label: 'Life expectancy', unit: 'years' },
  { code: 'SP.DYN.TFRT.IN', label: 'Births per woman', unit: 'children' },
  { code: 'SP.URB.TOTL.IN.ZS', label: 'Living in cities', unit: '% of people' },
  { code: 'SE.ADT.LITR.ZS', label: 'Literacy', unit: '% of adults' },
  { code: 'SH.XPD.CHEX.GD.ZS', label: 'Health spending', unit: '% of GDP' },
  { code: 'MS.MIL.XPND.GD.ZS', label: 'Military spending', unit: '% of GDP' },
  { code: 'MS.MIL.XPND.CD', label: 'Military spending', unit: 'US$ billions', scale: 1e9 },
  { code: 'IT.NET.USER.ZS', label: 'Internet users', unit: '% of people' },
  { code: 'IT.CEL.SETS.P2', label: 'Mobile subscriptions', unit: 'per 100 people' },
  { code: 'EG.ELC.ACCS.ZS', label: 'Access to electricity', unit: '% of people' },
  { code: 'AG.LND.FRST.ZS', label: 'Forest cover', unit: '% of land' },
  { code: 'ST.INT.ARVL', label: 'Tourist arrivals', unit: 'millions', scale: 1e6 },
  { code: 'TX.VAL.TECH.MF.ZS', label: 'High-tech exports', unit: '% of manufactured exports' },
  { code: 'PA.NUS.FCRF', label: 'Exchange rate', unit: 'local currency per US$' },
];

export const indicatorByCode = (code: string) => INDICATORS.find((i) => i.code === code);

/** The list as the shot director sees it. */
export function indicatorMenu(): string {
  return INDICATORS.map((i) => `${i.code} (${i.label}, ${i.unit})`).join('; ');
}

export interface DataSpec {
  indicator: string;
  /** ISO 3166 alpha-3 codes, e.g. "GBR". */
  countries: string[];
  from_year: number;
  to_year: number;
  /** trend: one line over the years; compare: bars for the latest year; race: bars racing year by year. */
  kind: 'trend' | 'compare' | 'race';
}

/** A spec kept within what charts can show; null when it can't be drawn. */
export function normalizeDataSpec(raw: unknown, currentYear = new Date().getFullYear()): DataSpec | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.indicator !== 'string' || !indicatorByCode(r.indicator)) return null;
  const kind = r.kind === 'trend' || r.kind === 'compare' || r.kind === 'race' ? r.kind : null;
  if (!kind) return null;
  const countries = Array.isArray(r.countries)
    ? [...new Set(r.countries.filter((c): c is string => typeof c === 'string').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c)))]
    : [];
  const max = kind === 'trend' ? 1 : 10;
  if (countries.length === 0 || countries.length > max || (kind !== 'trend' && countries.length < 2)) return null;
  let from = Math.round(Number(r.from_year));
  let to = Math.round(Number(r.to_year));
  if (!Number.isFinite(to) || to > currentYear) to = currentYear;
  if (!Number.isFinite(from) || from < 1960) from = Math.max(1960, to - 20);
  if (from >= to && kind !== 'compare') return null;
  return { indicator: r.indicator, countries, from_year: Math.min(from, to), to_year: to, kind };
}
