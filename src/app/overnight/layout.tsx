import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Overnight renders' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
