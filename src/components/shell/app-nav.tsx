'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { Icon, type IconName } from '@/components/ui/icon';
import { ButtonLink } from '@/components/ui/button';

/** The app's sections, in the order they appear in the menu. */
export const NAV_ITEMS: Array<{ href: string; label: string; icon: IconName; match?: (path: string) => boolean }> = [
  { href: '/', label: 'Videos', icon: 'film', match: (p) => p === '/' || (p.startsWith('/videos/') && p !== '/videos/new') },
  { href: '/clips', label: 'Clips', icon: 'scissors' },
  { href: '/hunts', label: 'Hunts', icon: 'target' },
  { href: '/moments', label: 'Compilations', icon: 'layers', match: (p) => p.startsWith('/moments') || p.startsWith('/compilations') },
  { href: '/library', label: 'Library', icon: 'library' },
  { href: '/overnight', label: 'Overnight', icon: 'moon' },
  { href: '/narrators', label: 'Narrators', icon: 'mic' },
  { href: '/styles', label: 'Styles', icon: 'palette' },
];

const isActive = (item: (typeof NAV_ITEMS)[number], path: string) => (item.match ? item.match(path) : path === item.href || path.startsWith(`${item.href}/`));

/**
 * The top bar on every page: the studio's name, its sections and "New video". On a phone the
 * sections fold into a menu under the bar.
 */
export function AppNav() {
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);
  // The menu closes when a link takes you to another page
  if (open && openedAt !== pathname) {
    setOpen(false);
    setOpenedAt(pathname);
  }

  return (
    <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/85 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/70">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-red-600 text-white">
            <Icon name="play" size={13} strokeWidth={2.4} />
          </span>
          <span className="text-sm font-bold tracking-tight text-zinc-50">Studio</span>
        </Link>

        <nav aria-label="Sections" className="ml-4 hidden min-w-0 flex-1 items-center gap-0.5 lg:flex">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors',
                  active ? 'bg-zinc-800/80 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100',
                )}
              >
                <Icon name={item.icon} size={15} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ButtonLink href="/videos/new" variant="primary" size="sm" icon="plus" className="hidden sm:inline-flex">
            New video
          </ButtonLink>
          <ButtonLink href="/videos/new" variant="primary" size="sm" className="sm:hidden w-9 px-0" aria-label="New video">
            <Icon name="plus" size={16} />
          </ButtonLink>
          <button
            type="button"
            onClick={() => {
              setOpen((o) => !o);
              setOpenedAt(pathname);
            }}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="grid h-9 w-9 place-items-center rounded-lg border border-zinc-800 text-zinc-300 hover:bg-zinc-900 lg:hidden"
          >
            <Icon name={open ? 'x' : 'menu'} size={18} />
          </button>
        </div>
      </div>

      {open && (
        <nav id="mobile-nav" aria-label="Sections" className="border-t border-zinc-800/80 bg-zinc-950 px-4 py-3 lg:hidden">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium',
                    active ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-300 hover:bg-zinc-900',
                  )}
                >
                  <Icon name={item.icon} size={16} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </header>
  );
}
