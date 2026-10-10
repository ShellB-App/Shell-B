import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { t } from '../../i18n';

export type ContactAvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

const PALETTES = [
  'bg-teal-500/15 text-teal-400 border-teal-500/30',
  'bg-sky-500/15 text-sky-400 border-sky-500/30',
  'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
  'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  'bg-violet-500/15 text-violet-400 border-violet-500/30',
  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  'bg-rose-500/15 text-rose-400 border-rose-500/30',
];

const SIZE_MAP: Record<ContactAvatarSize, { box: string; text: string; radius: string }> = {
  xs: { box: 'w-6 h-6', text: 'text-[10px] font-semibold', radius: 'rounded-full' },
  sm: { box: 'w-8 h-8', text: 'text-xs font-bold', radius: 'rounded-full' },
  md: { box: 'w-10 h-10', text: 'text-sm font-bold', radius: 'rounded-xl' },
  lg: { box: 'w-12 h-12', text: 'text-base font-bold', radius: 'rounded-2xl' },
  xl: { box: 'w-16 h-16', text: 'text-lg font-bold', radius: 'rounded-2xl' },
  '2xl': { box: 'w-20 h-20', text: 'text-xl font-bold', radius: 'rounded-2xl' },
};

function getPalette(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % PALETTES.length;
  return PALETTES[idx];
}

export function getInitials(name?: string): string {
  if (!name) return '?';
  const clean = name.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function ContactAvatar({
  name,
  avatar,
  size = 'md',
  shape,
  className,
}: {
  name?: string;
  avatar?: string;
  size?: ContactAvatarSize;
  shape?: 'circle' | 'square';
  className?: string;
}) {
  const [imgError, setImgError] = useState(false);
  const cfg = SIZE_MAP[size];
  const radius = shape === 'circle' ? 'rounded-full' : shape === 'square' ? 'rounded-2xl' : cfg.radius;
  const initials = getInitials(name);
  const palette = getPalette(name || '');

  useEffect(() => {
    setImgError(false);
  }, [avatar]);

  const cleanAvatar = avatar?.trim();
  const showImage = cleanAvatar && !imgError;

  return (
    <div
      className={clsx(
        cfg.box,
        radius,
        'relative shrink-0 overflow-hidden border select-none transition-all flex items-center justify-center',
        showImage ? 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)]' : palette,
        className
      )}
      title={name}
    >
      {showImage ? (
        <img
          src={cleanAvatar}
          alt={name || t('Contact photo')}
          className={clsx('w-full h-full object-cover', radius)}
          onError={() => setImgError(true)}
          loading="lazy"
        />
      ) : (
        <span className={clsx(cfg.text, 'leading-none tracking-tight')}>{initials}</span>
      )}
    </div>
  );
}
