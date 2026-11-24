import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

interface FieldWrapperProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
}

export function FieldLabel({ label, htmlFor, hint }: Omit<FieldWrapperProps, 'error'>) {
  return (
    <div className="flex items-baseline justify-between gap-2 mb-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-xs font-medium text-[#334155]"
      >
        {label}
      </label>
      {hint && <span className="text-xs text-[#64748B]">{hint}</span>}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Input({
  label,
  id,
  hint,
  error,
  className = '',
  ...props
}: InputProps) {
  const inputId = id || label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div>
      <FieldLabel label={label} htmlFor={inputId} hint={hint} />
      <input
        id={inputId}
        className={`w-full px-3 py-2 text-sm text-[#0F172A] bg-white border rounded-md transition-colors placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#1D4ED8]/20 focus:border-[#1D4ED8] disabled:bg-[#F8FAFC] disabled:text-[#64748B] ${
          error ? 'border-[#DC2626]' : 'border-[#E2E8F0]'
        } ${className}`}
        {...props}
      />
      {error && <p className="mt-1 text-xs text-[#B91C1C]">{error}</p>}
    </div>
  );
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Textarea({
  label,
  id,
  hint,
  error,
  className = '',
  ...props
}: TextareaProps) {
  const textareaId = id || label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div>
      <FieldLabel label={label} htmlFor={textareaId} hint={hint} />
      <textarea
        id={textareaId}
        className={`w-full px-3 py-2 text-sm text-[#0F172A] bg-white border rounded-md transition-colors placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#1D4ED8]/20 focus:border-[#1D4ED8] disabled:bg-[#F8FAFC] ${
          error ? 'border-[#DC2626]' : 'border-[#E2E8F0]'
        } ${className}`}
        {...props}
      />
      {error && <p className="mt-1 text-xs text-[#B91C1C]">{error}</p>}
    </div>
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: string;
  error?: string;
}

export function Select({
  label,
  id,
  hint,
  error,
  className = '',
  children,
  ...props
}: SelectProps) {
  const selectId = id || label.toLowerCase().replace(/\s+/g, '-');
  return (
    <div>
      <FieldLabel label={label} htmlFor={selectId} hint={hint} />
      <select
        id={selectId}
        className={`w-full px-3 py-2 text-sm text-[#0F172A] bg-white border rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-[#1D4ED8]/20 focus:border-[#1D4ED8] disabled:bg-[#F8FAFC] ${
          error ? 'border-[#DC2626]' : 'border-[#E2E8F0]'
        } ${className}`}
        {...props}
      >
        {children}
      </select>
      {error && <p className="mt-1 text-xs text-[#B91C1C]">{error}</p>}
    </div>
  );
}
