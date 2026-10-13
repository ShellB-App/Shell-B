import type { FC, SVGProps } from 'react';
import clsx from 'clsx';

export interface LanguageFlagProps extends SVGProps<SVGSVGElement> {
  code: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const LanguageFlag: FC<LanguageFlagProps> = ({ code, size = 'md', className, ...props }) => {
  const normalized = (code || '').toLowerCase().trim();

  const sizeClasses = {
    sm: 'w-4 h-2.5',
    md: 'w-5 h-3.5',
    lg: 'w-6 h-4',
  }[size];

  const commonProps = {
    viewBox: '0 0 60 40',
    className: clsx('inline-block rounded-xs overflow-hidden shrink-0 shadow-xs border border-black/10 align-middle select-none', sizeClasses, className),
    'aria-hidden': true,
    ...props,
  };

  switch (normalized) {
    // 🇬🇧 United Kingdom
    case 'en':
      return (
        <svg {...commonProps}>
          <clipPath id="uk-clip">
            <rect width="60" height="40" rx="2" />
          </clipPath>
          <g clipPath="url(#uk-clip)">
            <rect width="60" height="40" fill="#012169" />
            <path d="M0,0 L60,40 M60,0 L0,40" stroke="#fff" strokeWidth="8" />
            <path d="M0,0 L60,40" stroke="#c8102e" strokeWidth="3" strokeDasharray="30" strokeDashoffset="0" />
            <path d="M60,0 L0,40" stroke="#c8102e" strokeWidth="3" strokeDasharray="30" strokeDashoffset="0" />
            <path d="M30,0 v40 M0,20 h60" stroke="#fff" strokeWidth="12" />
            <path d="M30,0 v40 M0,20 h60" stroke="#c8102e" strokeWidth="7" />
          </g>
        </svg>
      );

    // 🇫🇷 France
    case 'fr':
      return (
        <svg {...commonProps}>
          <rect width="20" height="40" fill="#002654" />
          <rect x="20" width="20" height="40" fill="#ffffff" />
          <rect x="40" width="20" height="40" fill="#ce1126" />
        </svg>
      );

    // 🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scottish Gaelic (Saltire)
    case 'gd':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#0065bf" />
          <path d="M0,0 L60,40 M60,0 L0,40" stroke="#ffffff" strokeWidth="8" />
        </svg>
      );

    // 🇮🇪 Ireland
    case 'ga':
      return (
        <svg {...commonProps}>
          <rect width="20" height="40" fill="#169b62" />
          <rect x="20" width="20" height="40" fill="#ffffff" />
          <rect x="40" width="20" height="40" fill="#ff883e" />
        </svg>
      );

    // 🏴󠁧󠁢󠁷󠁬󠁳󠁿 Wales (Red Dragon)
    case 'cy':
      return (
        <svg {...commonProps}>
          <rect width="60" height="20" fill="#ffffff" />
          <rect y="20" width="60" height="20" fill="#00ab39" />
          {/* Stylized Welsh Red Dragon */}
          <path
            d="M22,12 C24,9 28,8 31,11 C34,10 37,12 39,15 C42,14 45,16 46,19 C47,23 45,26 41,27 C37,28 34,26 31,28 C28,30 25,31 22,29 C19,27 18,24 19,21 C20,17 19,15 22,12 Z"
            fill="#d30731"
          />
          <path d="M26,18 L34,13 L31,22 Z M35,16 L44,12 L39,21 Z" fill="#b00524" />
          <circle cx="25" cy="14" r="1.5" fill="#fff" />
        </svg>
      );

    // 🇮🇲 Isle of Man (Triskelion)
    case 'gv':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#cf142b" />
          <g transform="translate(30,20) scale(0.65)" stroke="#ffffff" strokeWidth="3" fill="#ffd700">
            <path d="M0,0 C2,-7 10,-9 14,-6 L18,-4" />
            <path d="M0,0 C-7,-2 -9,7 -6,12 L-4,16" />
            <path d="M0,0 C5,5 2,12 -3,13 L-7,15" />
            <circle cx="0" cy="0" r="3.5" fill="#ffd700" stroke="#fff" strokeWidth="1" />
          </g>
        </svg>
      );

    // ⬛ Cornish (St Piran's Cross)
    case 'kw':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#111111" />
          <rect x="25" width="10" height="40" fill="#ffffff" />
          <rect y="15" width="60" height="10" fill="#ffffff" />
        </svg>
      );

    // 🏴 Breton (Gwenn-ha-du)
    case 'br':
      return (
        <svg {...commonProps}>
          {/* 9 alternating black and white stripes */}
          <rect width="60" height="40" fill="#ffffff" />
          <rect y="4.4" width="60" height="4.4" fill="#111111" />
          <rect y="13.3" width="60" height="4.4" fill="#111111" />
          <rect y="22.2" width="60" height="4.4" fill="#111111" />
          <rect y="31.1" width="60" height="4.4" fill="#111111" />
          {/* Canton with ermine symbols */}
          <rect width="26" height="20" fill="#ffffff" stroke="#111111" strokeWidth="0.5" />
          <g fill="#111111" transform="scale(0.8) translate(3,2)">
            <path d="M6,6 C6,4 8,4 8,6 C8,7 7,8 7,9 L8,11 L6,11 L7,9 C7,8 6,7 6,6 Z" />
            <path d="M16,6 C16,4 18,4 18,6 C18,7 17,8 17,9 L18,11 L16,11 L17,9 C17,8 16,7 16,6 Z" />
            <path d="M11,12 C11,10 13,10 13,12 C13,13 12,14 12,15 L13,17 L11,17 L12,15 C12,14 11,13 11,12 Z" />
            <path d="M21,12 C21,10 23,10 23,12 C23,13 22,14 22,15 L23,17 L21,17 L22,15 C22,14 21,13 21,12 Z" />
          </g>
        </svg>
      );

    // 🟩 Basque (Ikurrina)
    case 'eu':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#d52b1e" />
          <path d="M0,0 L60,40 M60,0 L0,40" stroke="#009b48" strokeWidth="8" />
          <path d="M30,0 v40 M0,20 h60" stroke="#ffffff" strokeWidth="7" />
        </svg>
      );

    // 🇨🇭 Romansh (Swiss cross)
    case 'rm':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#d52b1e" />
          <rect x="25" y="10" width="10" height="20" fill="#ffffff" />
          <rect x="18" y="15" width="24" height="10" fill="#ffffff" />
        </svg>
      );

    // 🇱🇻 Livonian (Green, White, Blue tricolor)
    case 'liv':
      return (
        <svg {...commonProps}>
          <rect width="60" height="16" fill="#007a3d" />
          <rect y="16" width="60" height="8" fill="#ffffff" />
          <rect y="24" width="60" height="16" fill="#003399" />
        </svg>
      );

    // 🇫🇮 Inari Sámi (Sámi Flag)
    case 'smn':
      return (
        <svg {...commonProps}>
          <rect width="22" height="40" fill="#e3001b" />
          <rect x="22" width="6" height="40" fill="#009640" />
          <rect x="28" width="6" height="40" fill="#ffde00" />
          <rect x="34" width="26" height="40" fill="#0055a5" />
          {/* Sun/Moon Ring */}
          <circle cx="28" cy="20" r="11" fill="none" stroke="#e3001b" strokeWidth="2.5" />
          <path d="M28,9 A11,11 0 0,1 28,31" fill="none" stroke="#0055a5" strokeWidth="2.5" />
        </svg>
      );

    // 🇪🇸 Spain
    case 'es':
      return (
        <svg {...commonProps}>
          <rect width="60" height="10" fill="#aa151b" />
          <rect y="10" width="60" height="20" fill="#f1bf00" />
          <rect y="30" width="60" height="10" fill="#aa151b" />
          {/* Coat of arms silhouette badge */}
          <rect x="12" y="15" width="8" height="10" rx="2" fill="#c60b1e" stroke="#aa151b" strokeWidth="0.5" />
          <circle cx="16" cy="14" r="2" fill="#f1bf00" />
        </svg>
      );

    // 🇯🇵 Japan
    case 'ja':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#ffffff" />
          <circle cx="30" cy="20" r="11" fill="#bc002d" />
        </svg>
      );

    // 🇺🇦 Ukraine
    case 'uk':
      return (
        <svg {...commonProps}>
          <rect width="60" height="20" fill="#0057b7" />
          <rect y="20" width="60" height="20" fill="#ffd700" />
        </svg>
      );

    // 🇷🇸 Serbian (Cyrillic & Latin)
    case 'sr':
    case 'sr-latn':
      return (
        <svg {...commonProps}>
          <rect width="60" height="13.3" fill="#c6363c" />
          <rect y="13.3" width="60" height="13.3" fill="#0c4076" />
          <rect y="26.6" width="60" height="13.4" fill="#ffffff" />
          {/* Crest */}
          <g transform="translate(18, 12)">
            <path d="M0,0 h10 v8 c0,4 -5,8 -5,8 c0,0 -5,-4 -5,-8 Z" fill="#c6363c" stroke="#ffd700" strokeWidth="1" />
            <path d="M2,3 h6 v5 c0,2 -3,4 -3,4 c0,0 -3,-2 -3,-4 Z" fill="#fff" />
            <path d="M5,-2 L2,-4 L8,-4 Z" fill="#ffd700" />
          </g>
        </svg>
      );

    // 🏛️ Latin (Imperial Roman SPQR & Laurel Wreath)
    case 'la':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#7a1428" />
          <circle cx="30" cy="17" r="11" fill="none" stroke="#d4af37" strokeWidth="2" strokeDasharray="3,1.5" />
          <text x="30" y="34" fill="#ffd700" fontSize="7" fontWeight="bold" fontFamily="serif" textAnchor="middle" letterSpacing="0.5">
            SPQR
          </text>
        </svg>
      );

    // 🏺 Ancient Greek (Amphora on Aegean Blue with Meander band)
    case 'grc':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#0d47a1" />
          {/* White top and bottom meander bands */}
          <rect y="2" width="60" height="3" fill="#ffffff" />
          <rect y="35" width="60" height="3" fill="#ffffff" />
          {/* Gold Amphora silhouette */}
          <g transform="translate(30,19) scale(0.85)" fill="#ffd700">
            <ellipse cx="0" cy="2" rx="7" ry="9" />
            <path d="M-3,-10 h6 v5 h-6 Z" />
            <path d="M-5,-10 h10 v2 h-10 Z" />
            <path d="M-4,10 h8 v2 h-8 Z" />
            <path d="M-7,-2 C-10,-5 -8,-9 -4,-7 M7,-2 C10,-5 8,-9 4,-7" stroke="#ffd700" strokeWidth="1.5" fill="none" />
          </g>
        </svg>
      );

    // 📜 Old English (Anglo-Saxon Golden Dragon)
    case 'ang':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#8b0000" />
          <rect x="2" y="2" width="56" height="36" fill="none" stroke="#d4af37" strokeWidth="1" strokeDasharray="2,2" />
          {/* Golden Saxon Wyvern / Dragon */}
          <g transform="translate(30, 20) scale(0.75)" fill="#ffd700">
            <path d="M-12,4 C-10,-2 -4,-8 4,-8 C10,-8 14,-4 15,2 C12,1 8,2 6,4 C4,6 6,10 2,10 C-4,10 -6,7 -12,4 Z" />
            <path d="M-3,-7 C0,-14 6,-16 11,-12 C8,-11 6,-9 6,-7 Z" fill="#e6ca65" />
            <circle cx="8" cy="-5" r="1" fill="#8b0000" />
          </g>
        </svg>
      );

    // ᚱ Old Norse (Raven Banner)
    case 'non':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#801818" />
          <path d="M2,2 L58,2 L48,20 L58,38 L2,38 Z" fill="#b22222" />
          {/* Black Odin's Raven silhouette */}
          <g transform="translate(28, 20) scale(0.85)" fill="#111111">
            <path d="M-8,5 C-4,1 0,-2 6,-3 C12,-4 15,-1 14,3 C11,2 8,3 5,6 C2,8 0,9 -4,8 Z" />
            <path d="M2,-2 C5,-8 10,-11 13,-9 C11,-7 8,-5 7,-2 Z" />
            <circle cx="10" cy="-2" r="1" fill="#fff" />
          </g>
        </svg>
      );

    // 🟢 Esperanto (Verda Stelo)
    case 'eo':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#009900" />
          <rect width="24" height="20" fill="#ffffff" />
          {/* Green Star in Canton */}
          <polygon
            points="12,3 14.5,8 20,8.5 16,12.5 17.5,18 12,15 6.5,18 8,12.5 4,8.5 9.5,8"
            fill="#009900"
          />
        </svg>
      );

    // ⚔️ Klingon (Empire Trefoil)
    case 'tlh':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#990000" />
          <circle cx="30" cy="20" r="14" fill="#111111" />
          {/* Klingon Trefoil Insignia */}
          <g transform="translate(30, 20) scale(0.75)" fill="#ffffff">
            <path d="M0,-12 L4,-1 L11,-3 L5,6 L8,12 L0,9 L-8,12 L-5,6 L-11,-3 L-4,-1 Z" fill="#d30731" />
            <circle cx="0" cy="1" r="3.5" fill="#ffffff" />
            <circle cx="0" cy="1" r="2" fill="#111111" />
          </g>
        </svg>
      );

    // 🍃 Sindarin (Elvish White Tree & Star)
    case 'sjn':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#0a192f" />
          {/* Silver/White Elven Tree */}
          <g transform="translate(30, 22) scale(0.7)" stroke="#ffffff" strokeWidth="1.5" fill="none">
            <path d="M0,12 V-4" />
            <path d="M0,6 C-6,3 -10,-1 -11,-6" />
            <path d="M0,6 C6,3 10,-1 11,-6" />
            <path d="M0,1 C-4,-2 -7,-6 -7,-11" />
            <path d="M0,1 C4,-2 7,-6 7,-11" />
            <path d="M0,-4 C-3,-7 -4,-11 -3,-14" />
            <path d="M0,-4 C3,-7 4,-11 3,-14" />
            <circle cx="0" cy="-16" r="2" fill="#ffd700" stroke="none" />
          </g>
        </svg>
      );

    // 🐉 High Valyrian (Three-Headed Dragon on Black)
    case 'val':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#111111" />
          {/* Crimson Three-Headed Dragon */}
          <g transform="translate(30, 20) scale(0.7)" fill="#c8102e">
            <circle cx="0" cy="2" r="5" />
            <path d="M-8,-8 C-7,-4 -5,0 -2,2 M0,-10 V2 M8,-8 C7,-4 5,0 2,2" stroke="#c8102e" strokeWidth="2.5" fill="none" />
            <circle cx="-9" cy="-8" r="2" />
            <circle cx="0" cy="-11" r="2" />
            <circle cx="9" cy="-8" r="2" />
            {/* Wings */}
            <path d="M-4,3 C-12,0 -16,8 -14,14 C-10,12 -7,8 -3,6" />
            <path d="M4,3 C12,0 16,8 14,14 C10,12 7,8 3,6" />
          </g>
        </svg>
      );

    // 🏴‍☠️ Pirate Speak (Jolly Roger)
    case 'en-pirate':
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#0a0a0a" />
          {/* Crossed Bones & Skull */}
          <g transform="translate(30, 20) scale(0.75)" fill="#ffffff">
            <path d="M-12,-8 L12,8 M12,-8 L-12,8" stroke="#ffffff" strokeWidth="2.5" strokeLinecap="round" />
            <ellipse cx="0" cy="-3" rx="6" ry="5.5" />
            <rect x="-3" y="1.5" width="6" height="3.5" rx="1" />
            {/* Eye Sockets and Teeth */}
            <circle cx="-2.5" cy="-3" r="1.5" fill="#0a0a0a" />
            <circle cx="2.5" cy="-3" r="1.5" fill="#0a0a0a" />
            <line x1="-1.5" y1="2" x2="-1.5" y2="4.5" stroke="#0a0a0a" strokeWidth="0.8" />
            <line x1="1.5" y1="2" x2="1.5" y2="4.5" stroke="#0a0a0a" strokeWidth="0.8" />
          </g>
        </svg>
      );

    default:
      return (
        <svg {...commonProps}>
          <rect width="60" height="40" fill="#2d3748" />
          <circle cx="30" cy="20" r="10" fill="none" stroke="#a0aec0" strokeWidth="2" />
          <path d="M20,20 h20 M30,10 v20" stroke="#a0aec0" strokeWidth="2" />
        </svg>
      );
  }
};
