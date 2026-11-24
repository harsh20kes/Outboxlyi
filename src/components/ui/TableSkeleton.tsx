export function TableSkeleton({
  rows = 6,
  cols = 5,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div className="divide-y divide-[#E2E8F0]">
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <div
          key={rowIdx}
          className="grid gap-4 px-5 py-3 items-center"
          style={{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          }}
        >
          {Array.from({ length: cols }).map((__, colIdx) => (
            <div
              key={colIdx}
              className="h-4 bg-[#E2E8F0]/70 rounded animate-pulse"
              style={{
                width: colIdx === 0 ? '85%' : colIdx === cols - 1 ? '60%' : '75%',
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
