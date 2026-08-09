import ansiEscapes from "ansi-escapes";

export function clearScreen(): void {
  process.stdout.write(ansiEscapes.clearTerminal);
}

export function moveCursor(x: number, y: number): void {
  process.stdout.write(ansiEscapes.cursorTo(x, y));
}

export function hideCursor(): void {
  process.stdout.write(ansiEscapes.cursorHide);
}

export function showCursor(): void {
  process.stdout.write(ansiEscapes.cursorShow);
}

export function getSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}
