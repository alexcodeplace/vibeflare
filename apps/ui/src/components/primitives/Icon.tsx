import {
  AlertCircle,
  BarChart2,
  Check,
  Download,
  ExternalLink,
  File,
  Github,
  Home,
  Image,
  Info,
  Key,
  KeyRound,
  MessageSquare,
  Mic,
  Moon,
  Plus,
  Send,
  Settings,
  Square,
  Star,
  Sun,
  Trash2,
  Upload,
  User,
  Zap,
} from 'lucide-react';
import type { LucideProps } from 'lucide-react';
import { Icon as AstryxIcon } from '@astryxdesign/core/Icon';

const ICONS = {
  AlertCircle,
  BarChart2,
  Check,
  Download,
  ExternalLink,
  File,
  Github,
  Home,
  Image,
  Info,
  Key,
  KeyRound,
  MessageSquare,
  Mic,
  Moon,
  Plus,
  Send,
  Settings,
  Square,
  Star,
  Sun,
  Trash2,
  Upload,
  User,
  Zap,
} as const;

// Keep unmapped specialist glyphs, but reuse the exact Club sprite wherever it has a counterpart.
const CLUB_GLYPHS: Partial<Record<keyof typeof ICONS, string>> = {
  BarChart2: 'bar-chart', Check: 'check', Download: 'download', ExternalLink: 'link',
  File: 'file', Github: 'code-host', Home: 'home', Info: 'info', Key: 'lock', KeyRound: 'lock',
  MessageSquare: 'chat', Moon: 'moon', Settings: 'settings', Star: 'star', Sun: 'sun',
  Upload: 'upload', User: 'user', Zap: 'bolt',
};

export type IconName = keyof typeof ICONS;
export interface IconProps extends Omit<LucideProps, 'size' | 'color'> {
  name: IconName;
  size?: 'sm' | 'md' | 'lg';
}

/** Every application glyph passes through Astryx Icon for sizing/theming/a11y. */
export function Icon({ name, size = 'md', className, 'aria-label': ariaLabel, ...rest }: IconProps) {
  const clubGlyph = CLUB_GLYPHS[name];
  if (clubGlyph) {
    const pixels = { sm: 16, md: 20, lg: 24 }[size];
    return <svg width={pixels} height={pixels} viewBox="0 0 24 24" fill="none" className={className}
      aria-hidden={ariaLabel ? undefined : true} aria-label={ariaLabel} role={ariaLabel ? 'img' : undefined} focusable="false" {...rest}>
      <use href={`/assets/club/icons.svg#${clubGlyph}`} />
    </svg>;
  }
  const Glyph = ICONS[name];
  return (
    <AstryxIcon
      icon={Glyph}
      size={size}
      className={className}
      label={typeof ariaLabel === 'string' ? ariaLabel : undefined}
      {...rest}
    />
  );
}
