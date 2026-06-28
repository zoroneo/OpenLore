/**
 * Job-grouped `openlore --help` (change: refine-happy-path-and-defaults /
 * CommandSurfaceGroupedByJob).
 *
 * OpenLore has ~49 top-level commands. Commander's default help lists them in one
 * flat block, so `install` and `orient` sit beside the experimental `panic-*`
 * suite and `gryph-watch` with no altitude marker — a new user can't tell the
 * front door from the basement. This module groups the Commands section of the
 * top-level help by JOB (set up · navigate · govern a change · inspect · multi-repo
 * · advanced/experimental), mirroring the capability families.
 *
 * It only changes PRESENTATION. Every command stays invocable, and any command not
 * yet categorized falls through to an "Other" group, so a newly-added command is
 * never hidden — it just shows ungrouped until it is placed. The override is a
 * faithful reproduction of Commander 12's `formatHelp`, delegating every other
 * section (usage, description, arguments, options, global options) to the supplied
 * helper unchanged; only the Commands section is grouped.
 */

import type { Command, Help } from 'commander';

/** Job groups, in display order. Each lists the command names it contains. */
export const COMMAND_GROUPS: ReadonlyArray<{ title: string; commands: readonly string[] }> = [
  {
    title: 'Set up & run',
    commands: ['install', 'connect', 'init', 'analyze', 'embed', 'mcp', 'serve', 'doctor', 'features', 'setup', 'update', 'view'],
  },
  {
    title: 'Navigate the code',
    commands: ['orient', 'prove'],
  },
  {
    title: 'Govern a change',
    commands: [
      'blast-radius',
      'impact-certificate',
      'certify-public-surface',
      'enforce',
      'review',
      'preflight',
      'drift',
      'decisions',
      'coverage-gaps',
      'working-set',
      'briefing-since',
    ],
  },
  {
    title: 'Inspect & author specs',
    commands: ['audit', 'env-impact', 'error-propagation', 'find-clones', 'style-fingerprint', 'test', 'digest', 'generate', 'verify', 'run'],
  },
  {
    title: 'Multi-repo & sharing',
    commands: ['federation', 'spec-store', 'export', 'import', 'manifest', 'plugin-manifest'],
  },
  {
    title: 'Advanced / experimental',
    commands: ['panic-check', 'panic-level', 'panic-validate', 'panic-hotspots', 'panic-calibrate', 'panic-replay', 'gryph-watch', 'telemetry', 'refresh-stories'],
  },
];

/** The label for any command not placed in a group above (safety net — never hidden). */
const OTHER_GROUP_TITLE = 'Other';

/** Resolve which group a command name belongs to, or the Other group. */
export function groupForCommand(name: string): string {
  for (const g of COMMAND_GROUPS) {
    if (g.commands.includes(name)) return g.title;
  }
  return OTHER_GROUP_TITLE;
}

/**
 * A Commander `formatHelp` replacement that groups the Commands section by job.
 * Faithful to Commander 12's default for every other section.
 */
export function groupedFormatHelp(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper);
  const helpWidth = helper.helpWidth || 80;
  const itemIndentWidth = 2;
  const itemSeparatorWidth = 2;

  function formatItem(term: string, description: string): string {
    if (description) {
      const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
      return helper.wrap(fullText, helpWidth - itemIndentWidth, termWidth + itemSeparatorWidth);
    }
    return term;
  }
  function formatList(textArray: string[]): string {
    return textArray.join('\n').replace(/^/gm, ' '.repeat(itemIndentWidth));
  }

  // Usage
  let output: string[] = [`Usage: ${helper.commandUsage(cmd)}`, ''];

  // Description
  const commandDescription = helper.commandDescription(cmd);
  if (commandDescription.length > 0) {
    output = output.concat([helper.wrap(commandDescription, helpWidth, 0), '']);
  }

  // Arguments
  const argumentList = helper.visibleArguments(cmd).map((argument) =>
    formatItem(helper.argumentTerm(argument), helper.argumentDescription(argument))
  );
  if (argumentList.length > 0) {
    output = output.concat(['Arguments:', formatList(argumentList), '']);
  }

  // Options
  const optionList = helper.visibleOptions(cmd).map((option) =>
    formatItem(helper.optionTerm(option), helper.optionDescription(option))
  );
  if (optionList.length > 0) {
    output = output.concat(['Options:', formatList(optionList), '']);
  }

  // Global Options
  // (Help.showGlobalOptions is set via configureHelp; reproduce the same gate.)
  if ((helper as unknown as { showGlobalOptions?: boolean }).showGlobalOptions) {
    const globalOptionList = helper
      .visibleGlobalOptions(cmd)
      .map((option) => formatItem(helper.optionTerm(option), helper.optionDescription(option)));
    if (globalOptionList.length > 0) {
      output = output.concat(['Global Options:', formatList(globalOptionList), '']);
    }
  }

  // Commands — GROUPED BY JOB (the only departure from the default).
  const visible = helper.visibleCommands(cmd);
  if (visible.length > 0) {
    output.push('Commands:');
    output.push('');
    const byName = new Map(visible.map((c) => [c.name(), c]));
    const used = new Set<string>();

    const renderGroup = (title: string, cmds: Command[]): void => {
      if (cmds.length === 0) return;
      output.push(`  ${title}`);
      const items = cmds.map((c) => formatItem(helper.subcommandTerm(c), helper.subcommandDescription(c)));
      // Indent group members one level deeper than the group title.
      output.push(formatList(items).replace(/^/gm, '  '));
      output.push('');
    };

    for (const group of COMMAND_GROUPS) {
      const cmds = group.commands.map((n) => byName.get(n)).filter((c): c is Command => Boolean(c));
      cmds.forEach((c) => used.add(c.name()));
      renderGroup(group.title, cmds);
    }
    // Safety net: any visible command not yet placed (e.g. a newly-added one).
    const leftover = visible.filter((c) => !used.has(c.name()));
    renderGroup(OTHER_GROUP_TITLE, leftover);
  }

  return output.join('\n');
}
