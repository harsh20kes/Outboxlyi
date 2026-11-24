import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-16">
      <div className="w-10 h-10 flex items-center justify-center rounded-md bg-[#F1F5F9] text-[#475569] border border-[#E2E8F0] mb-4">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-[#0F172A]">{title}</h3>
      <p className="mt-1.5 text-sm text-[#475569] max-w-md">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
