import { useCountUp } from '../hooks/use-count-up';

interface AnimatedValueProps {
  value: string | number;
}

export function AnimatedValue({ value }: AnimatedValueProps) {
  // Always call useCountUp unconditionally to satisfy the Rules of Hooks.
  //
  // Regex pattern: integer prefix (`\d+`), optionally followed by a non-digit
  // character and the rest of the string. The `[^\d.]` guard rejects decimals
  // like `"76.9%"` that would otherwise partially match (`76` + `.9%`) and
  // render a broken count-up (`"0.9%"`, `"37.9%"`, `"76.9%"`). Decimal or
  // otherwise non-matching strings fall through to static rendering.
  const stringMatch = typeof value === 'string' ? value.match(/^(\d+)([^\d.].*)?$/) : null;
  // Group 1 is `(\d+)` and is mandatory in a successful match, so when
  // `stringMatch` is truthy, `stringMatch[1]` is always a string. The `?? '0'`
  // exists only to satisfy `noUncheckedIndexedAccess` (#1058 M38).
  const target = typeof value === 'number' ? value : stringMatch ? parseInt(stringMatch[1] ?? '0', 10) : 0;
  const animated = useCountUp(target);

  if (typeof value === 'number') return <>{animated}</>;
  if (!stringMatch) return <>{value}</>;
  return (
    <>
      {animated}
      {stringMatch[2] ?? ''}
    </>
  );
}
