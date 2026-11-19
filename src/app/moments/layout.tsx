import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Compilations' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
