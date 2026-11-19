import React from 'react';
import Link from 'next/link';
import { cn } from './cn';
import { Icon, type IconName } from './icon';

/**
 * Buttons: primary (the one main action on a screen), secondary (most actions), ghost (quiet,
 * in toolbars) and danger. Sizes sm (dense panels) and md. Touch targets stay at least 36px.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white border border-indigo-500/60 shadow-sm shadow-indigo-950/40',
  secondary: 'bg-zinc-900 hover:bg-zinc-800 text-zinc-100 border border-zinc-700/80 hover:border-zinc-600',
  ghost: 'bg-transparent hover:bg-zinc-800/70 text-zinc-300 hover:text-zinc-100 border border-transparent',
  danger: 'bg-red-600/90 hover:bg-red-500 text-white border border-red-500/60',
};
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string): string {
  return cn(
    'inline-flex items-center justify-center font-semibold whitespace-nowrap transition-colors select-none',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
    'disabled:opacity-50 disabled:pointer-events-none',
    VARIANT[variant],
    SIZE[size],
    className,
  );
}

type Common = { variant?: ButtonVariant; size?: ButtonSize; icon?: IconName; iconRight?: IconName };

export function Button({ variant, size, icon, iconRight, className, children, type = 'button', ...rest }: Common & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const s = size === 'sm' ? 14 : 16;
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={s} />}
      {children}
      {iconRight && <Icon name={iconRight} size={s} />}
    </button>
  );
}

export function ButtonLink({ variant, size, icon, iconRight, className, children, href, ...rest }: Common & { href: string } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const s = size === 'sm' ? 14 : 16;
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {icon && <Icon name={icon} size={s} />}
      {children}
      {iconRight && <Icon name={iconRight} size={s} />}
    </Link>
  );
}
