export function SkeletonLoader() {
  return (
    <div class="skeleton-row">
      {[...Array(5)].map((_, i) => (
        <div key={i} class="skeleton-card" />
      ))}
    </div>
  );
}
