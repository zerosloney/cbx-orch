import chalk from "chalk";

export const theme: Record<string, (s: string) => string> = {
  done: chalk.green,
  failed: chalk.red,
  review_failed: chalk.red,
  needs_fix: chalk.red,
  running: chalk.yellow,
  awaiting_approval: chalk.yellow,
  queued: chalk.cyan,
  cancelled: chalk.gray,
};

export function colorizeStatus(status: string): string {
  const color = theme[status] ?? chalk.white;
  return color(status);
}
