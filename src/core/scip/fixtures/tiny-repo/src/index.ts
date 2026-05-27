import { greet } from './greet.js';
import { add } from './math.js';

/** Entry point: greets the world and adds two numbers. */
export function main(): void {
  greet('world');
  add(1, 2);
}
