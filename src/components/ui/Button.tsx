import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-[#1D4ED8] text-white hover:bg-[#1E40AF] border border-[#1D4ED8] focus-visible:ring-2 focus-visible:ring-[#1D4ED8]/40 focus-visible:ring-offset-2',
  secondary:
    'bg-white text-[#0F172A] hover:bg-[#F8FAFC] border border-[#E2E8F0] focus-visible:ring-2 focus-visible:ring-[#1D4ED8]/30 focus-visible:ring-offset-2',
  ghost:
    'bg-transparent text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] border border-transparent focus-visible:ring-2 focus-visible:ring-[#1D4ED8]/30',
  danger:
    'bg-white text-[#B91C1C] hover:bg-[#FEF2F2] border border-[#FECACA] focus-visible:ring-2 focus-visible:ring-[#B91C1C]/30',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-sm',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  disabled,
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 font-medium rounded-md transition-colors duration-150 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}
