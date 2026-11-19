import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Clip to Short' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
