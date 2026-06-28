/**
 * Tests for job-grouped `openlore --help` (change: refine-happy-path-and-defaults /
 * CommandSurfaceGroupedByJob). Verifies the Commands section is grouped by job, that
 * every command stays visible (uncategorized commands fall to "Other", never hidden),
 * and that the grouping data is internally consistent.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { COMMAND_GROUPS, groupForCommand, groupedFormatHelp } from './help-groups.js';

function renderHelp(commandNames: string[]): string {
  const program = new Command('openlore');
  program.configureHelp({ formatHelp: groupedFormatHelp });
  for (const name of commandNames) {
    program.command(name).description(`does ${name}`);
  }
  return program.helpInformation();
}

describe('help-groups', () => {
  it('has no duplicate command name across groups', () => {
    const all = COMMAND_GROUPS.flatMap((g) => g.commands);
    expect(new Set(all).size).toBe(all.length);
  });

  it('maps known commands to their job group and unknowns to Other', () => {
    expect(groupForCommand('install')).toBe('Set up & run');
    expect(groupForCommand('orient')).toBe('Navigate the code');
    expect(groupForCommand('enforce')).toBe('Govern a change');
    expect(groupForCommand('panic-check')).toBe('Advanced / experimental');
    expect(groupForCommand('federation')).toBe('Multi-repo & sharing');
    expect(groupForCommand('features')).toBe('Set up & run');
    expect(groupForCommand('totally-new-command')).toBe('Other');
  });

  it('renders the Commands section grouped by job, in declared order', () => {
    const help = renderHelp(['install', 'orient', 'enforce', 'panic-check']);
    expect(help).toContain('Set up & run');
    expect(help).toContain('Navigate the code');
    expect(help).toContain('Govern a change');
    expect(help).toContain('Advanced / experimental');
    // Order: set-up group header precedes the govern group header.
    expect(help.indexOf('Set up & run')).toBeLessThan(help.indexOf('Govern a change'));
    // A command renders under its group.
    expect(help).toMatch(/Navigate the code[\s\S]*orient/);
  });

  it('never hides a command: an uncategorized command falls under Other', () => {
    const help = renderHelp(['install', 'brand-new-cmd']);
    expect(help).toContain('brand-new-cmd');
    expect(help).toMatch(/Other[\s\S]*brand-new-cmd/);
  });

  it('omits a group header when no command in it is present', () => {
    const help = renderHelp(['install']); // only a Set-up command
    expect(help).toContain('Set up & run');
    expect(help).not.toContain('Govern a change');
    expect(help).not.toContain('Advanced / experimental');
  });

  it('preserves the usage and options sections (faithful to the default formatHelp)', () => {
    const program = new Command('openlore');
    program.configureHelp({ formatHelp: groupedFormatHelp });
    program.option('-q, --quiet', 'minimal output');
    program.command('install').description('set up');
    const help = program.helpInformation();
    expect(help).toMatch(/Usage: openlore/);
    expect(help).toContain('Options:');
    expect(help).toContain('--quiet');
  });
});
