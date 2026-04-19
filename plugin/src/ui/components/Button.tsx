import React, { useState } from 'react';

export type ButtonVariant = 'primary' | 'secondary';
export type ButtonSize = 'standard' | 'compact';

export interface ButtonProps {
  children?: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  style?: React.CSSProperties;
}

export function Button({
  children = 'Knappetekst',
  variant = 'primary',
  size = 'standard',
  onClick,
  disabled = false,
  type = 'button',
  style,
}: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const isCompact = size === 'compact';

  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    padding: isCompact ? '4px 9px 0px' : '4px 13px',
    fontFamily: '"GT America", sans-serif',
    fontStyle: 'normal',
    fontWeight: 500,
    fontSize: isCompact ? 12 : 16,
    lineHeight: 1.5,
    letterSpacing: 0,
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    opacity: disabled ? 0.4 : 1,
    outline: 'none',
    boxSizing: 'border-box',
    // reset browser button defaults
    appearance: 'none',
    // Always reserve 1px border so layout doesn't shift between states
    border: '1px solid transparent',
    background: 'none',
  };

  const variantStyle: React.CSSProperties = (() => {
    if (variant === 'primary') {
      if (pressed) {
        return {
          background: '#accf1f', // --color/accent/base-active
          color: '#272f07',      // --color/accent/text-default
        };
      }
      if (hovered) {
        return {
          background: '#c0e722', // --color/accent/base-hover
          color: '#272f07',
        };
      }
      // default: outline only
      return {
        borderColor: '#797979',
        color: '#2b2b2b',
      };
    }

    // secondary: outline on hover only
    if (hovered) {
      return {
        borderColor: '#797979',
        color: '#2b2b2b',
      };
    }
    return {
      color: '#2b2b2b',
    };
  })();

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => !disabled && setHovered(true)}
      onMouseLeave={() => { setHovered(false); setPressed(false); }}
      onMouseDown={() => !disabled && setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{ ...base, ...variantStyle, ...style }}
    >
      {children}
    </button>
  );
}
