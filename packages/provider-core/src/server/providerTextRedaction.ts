function redactUrl(match: string): string {
  const trailing = /[),.;!?]+$/u.exec(match)?.[0] ?? "";
  const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function replaceUnsafeControlCharacters(value: string): string {
  const sanitized: Array<string> = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized.push(
      codePoint <= 0x08 ||
        (codePoint >= 0x0b && codePoint <= 0x0c) ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
        ? " "
        : character,
    );
  }
  return sanitized.join("");
}

/** Removes common credential forms before provider text crosses a transport boundary. */
export function redactProviderText(value: string): string {
  return replaceUnsafeControlCharacters(value)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /(["'](?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /(\b(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .trim();
}
