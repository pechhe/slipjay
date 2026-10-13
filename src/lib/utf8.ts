export function truncateUtf8(value: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= limit)
    return value;
  let end = limit;
  while (end > 0 && (encoded[end]! & 192) === 128)
    end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}
