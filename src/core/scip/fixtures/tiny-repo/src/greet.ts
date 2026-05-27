import { double } from './math.js';

/** Greets a name, using its length doubled as a flourish. */
export function greet(name: string): string {
  return `Hello ${name} (${double(name.length)})`;
}
