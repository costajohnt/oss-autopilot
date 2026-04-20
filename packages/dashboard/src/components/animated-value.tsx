import { useCountUp } from '../hooks/use-count-up';

interface AnimatedValueProps {
  value: string | number;
}

export function AnimatedValue({ value }: AnimatedValueProps) {
  // Always call useCountUp unconditionally to satisfy the Rules of Hooks:
  // if `value` transitions between number/string/non-numeric-string across
  // renders, a conditional hook call would throw "Rendered fewer hooks".
  const stringMatch = typeof value === 'string' ? value.match(/^(\d+)(.*)$/) : null;
  const target = typeof value === 'number' ? value : stringMatch ? parseInt(stringMatch[1], 10) : 0;
  const animated = useCountUp(target);

  if (typeof value === 'number') return <>{animated}</>;
  if (!stringMatch) return <>{value}</>;
  return (
    <>
      {animated}
      {stringMatch[2]}
    </>
  );
}
