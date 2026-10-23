export function normalize(value: number, minValue: number, maxValue: number): number | undefined {
  return (value - minValue) / (maxValue - minValue) * 100;
}

export function denormalize(number: number, minValue: number, maxValue: number) {
  return number * (maxValue - minValue) / 100 + minValue;
}
