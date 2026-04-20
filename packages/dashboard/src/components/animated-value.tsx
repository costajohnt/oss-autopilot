import { useCountUp } from '../hooks/use-count-up';

interface AnimatedValueProps {
  value: string | number;
}

export function AnimatedValue({ value }: AnimatedValueProps) {
  if (typeof value === 'number') {
    return <>{useCountUp(value)}</>;
  }

  const match = value.match(/^(\d+)(.*)$/);
  if (!match) return <>{value}</>;

  const num = parseInt(match[1], 10);
  const suffix = match[2];

  return (
    <>
      {useCountUp(num)}
      {suffix}
    </>
  );
}
