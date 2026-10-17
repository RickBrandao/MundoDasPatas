import type { CSSProperties } from 'react';

interface IconProps {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** Ícone Material Symbols Rounded (decorativo; o rótulo acessível fica no elemento pai). */
export function Icon({ name, size = 20, filled, className, style }: IconProps) {
  return (
    <span
      aria-hidden="true"
      className={className ? `icon ${className}` : 'icon'}
      style={{ fontSize: size, ...(filled ? { fontVariationSettings: "'FILL' 1" } : null), ...style }}
    >
      {name}
    </span>
  );
}
