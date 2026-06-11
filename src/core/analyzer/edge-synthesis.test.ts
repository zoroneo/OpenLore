/**
 * Dynamic-dispatch edge synthesis (spec: add-synthesized-dynamic-dispatch-edges).
 * Tests the event-channel and route-handler rules + provenance through the real
 * CallGraphBuilder.build(). Route tests use on-disk fixtures because route
 * detection reads from disk by path (as the existing HTTP edge pass does).
 * Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallGraphBuilder, EVENT_CHANNEL_FANOUT_CAP } from './call-graph.js';
import type { CallEdge, FunctionNode } from './call-graph.js';

type Built = Awaited<ReturnType<CallGraphBuilder['build']>>;
const idByName = (b: Built, name: string): string | undefined =>
  [...b.nodes.values()].find((n: FunctionNode) => n.name === name)?.id;
const synthEdges = (b: Built): CallEdge[] => b.edges.filter(e => e.confidence === 'synthesized');
const edgeBetween = (b: Built, fromName: string, toName: string): CallEdge | undefined => {
  const from = idByName(b, fromName), to = idByName(b, toName);
  return b.edges.find(e => e.callerId === from && e.calleeId === to);
};

describe('event-channel synthesis', () => {
  const build = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'src/app.ts', content, language: 'TypeScript' }]);

  it('Event handler is reachable through a synthesized edge', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function register(emitter: any) { emitter.on('mount', onMount); }
      function trigger(emitter: any) { emitter.emit('mount'); }
    `);
    const edge = edgeBetween(b, 'trigger', 'onMount');
    expect(edge).toBeDefined();
    expect(edge!.confidence).toBe('synthesized');
    expect(edge!.synthesizedBy).toBe('event-channel');
    expect(edge!.kind).toBe('calls');
  });

  it('Mismatched channel keys produce no edge', async () => {
    const b = await build(`
      function handler() { return 1; }
      function register(e: any) { e.on('open', handler); }
      function trigger(e: any) { e.emit('close'); }
    `);
    expect(edgeBetween(b, 'trigger', 'handler')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('Unpaired dispatch emits nothing', async () => {
    const b = await build(`
      function trigger(e: any) { e.emit('change'); }
    `);
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('addEventListener registration is recognized', async () => {
    const b = await build(`
      function onClick() { return 1; }
      function wire(el: any) { el.addEventListener('click', onClick); }
      function fire(el: any) { el.dispatch('click'); }
    `);
    const edge = edgeBetween(b, 'fire', 'onClick');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('Over-cap channel is dropped, not guessed', async () => {
    const handlers = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP + 1 }, (_, i) => `function h${i}() { return ${i}; }`).join('\n');
    const regs = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP + 1 }, (_, i) => `e.on('busy', h${i});`).join('\n');
    const b = await build(`
      ${handlers}
      function register(e: any) { ${regs} }
      function trigger(e: any) { e.emit('busy'); }
    `);
    // Over the cap → channel dropped entirely, no synthesized edges for it.
    expect(synthEdges(b).filter(e => e.synthesizedBy === 'event-channel')).toHaveLength(0);
  });

  it('At-cap channel still wires (boundary)', async () => {
    const handlers = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP }, (_, i) => `function g${i}() { return ${i}; }`).join('\n');
    const regs = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP }, (_, i) => `e.on('ok', g${i});`).join('\n');
    const b = await build(`
      ${handlers}
      function register(e: any) { ${regs} }
      function trigger(e: any) { e.emit('ok'); }
    `);
    expect(synthEdges(b).length).toBe(EVENT_CHANNEL_FANOUT_CAP);
  });

  it('Synthesized edge carries provenance; direct edges do not', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function helper() { return onMount(); }
      function register(e: any) { e.on('mount', onMount); }
      function trigger(e: any) { e.emit('mount'); }
    `);
    for (const e of b.edges) {
      if (e.confidence === 'synthesized') expect(e.synthesizedBy).toBeTruthy();
      else expect(e.synthesizedBy).toBeUndefined();
    }
    // The direct call helper → onMount stays directly-resolved.
    const direct = edgeBetween(b, 'helper', 'onMount');
    expect(direct?.confidence).not.toBe('synthesized');
    expect(direct?.synthesizedBy).toBeUndefined();
  });

  it('Cross-file registration and dispatch pair by key', async () => {
    const b = await new CallGraphBuilder().build([
      { path: 'src/handlers.ts', content: 'export function onSave() { return 1; }', language: 'TypeScript' },
      { path: 'src/wire.ts', content: `import { onSave } from './handlers';\nfunction reg(e: any) { e.on('save', onSave); }`, language: 'TypeScript' },
      { path: 'src/fire.ts', content: `function go(e: any) { e.emit('save'); }`, language: 'TypeScript' },
    ]);
    const edge = edgeBetween(b, 'go', 'onSave');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('resolves a member-expression handler (this.fn / obj.fn)', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function register(e: any) { e.on('mount', this.onMount); }
      function trigger(e: any) { e.emit('mount'); }
    `);
    expect(edgeBetween(b, 'trigger', 'onMount')?.synthesizedBy).toBe('event-channel');
  });

  it('unwraps a .bind() handler reference', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function register(e: any) { e.on('mount', onMount.bind(this)); }
      function trigger(e: any) { e.emit('mount'); }
    `);
    expect(edgeBetween(b, 'trigger', 'onMount')?.synthesizedBy).toBe('event-channel');
  });

  it('wires an inline arrow handler to the functions its body calls', async () => {
    const b = await build(`
      function realHandler() { return 1; }
      function register(e: any) { e.on('mount', () => { realHandler(); }); }
      function trigger(e: any) { e.emit('mount'); }
    `);
    expect(edgeBetween(b, 'trigger', 'realHandler')?.synthesizedBy).toBe('event-channel');
  });

  it('pairs on a constant member-expression key (EVENTS.MOUNT)', async () => {
    const b = await build(`
      const EVENTS = { MOUNT: 'mount' };
      function onMount() { return 1; }
      function register(e: any) { e.on(EVENTS.MOUNT, onMount); }
      function trigger(e: any) { e.emit(EVENTS.MOUNT); }
    `);
    expect(edgeBetween(b, 'trigger', 'onMount')?.synthesizedBy).toBe('event-channel');
  });

  it('pairs on a substitution-free template-literal key', async () => {
    const b = await build([
      'function onMount() { return 1; }',
      'function register(e: any) { e.on(`mount`, onMount); }',
      'function trigger(e: any) { e.emit(`mount`); }',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'onMount')?.synthesizedBy).toBe('event-channel');
  });

  it('does NOT pair a string key with a same-text constant key (namespace isolation)', async () => {
    const b = await build(`
      const EVENTS = { MOUNT: 'mount' };
      function onMount() { return 1; }
      function register(e: any) { e.on(EVENTS.MOUNT, onMount); }
      function trigger(e: any) { e.emit('EVENTS.MOUNT'); }
    `);
    // 'EVENTS.MOUNT' (string) must not pair with EVENTS.MOUNT (constant ref).
    expect(edgeBetween(b, 'trigger', 'onMount')).toBeUndefined();
  });

  it('ignores a computed/dynamic dispatch key (no guess)', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function register(e: any) { e.on('mount', onMount); }
      function trigger(e: any, k: string) { e.emit(k); }
    `);
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('supports pub/sub verbs (subscribe / publish)', async () => {
    const b = await build(`
      function onTopic() { return 1; }
      function register(bus: any) { bus.subscribe('topic', onTopic); }
      function fire(bus: any) { bus.publish('topic'); }
    `);
    expect(edgeBetween(b, 'fire', 'onTopic')?.synthesizedBy).toBe('event-channel');
  });

  it('supports DOM dispatchEvent(new CustomEvent(k)) key extraction', async () => {
    const b = await build(`
      function onClick() { return 1; }
      function wire(el: any) { el.addEventListener('click', onClick); }
      function fire(el: any) { el.dispatchEvent(new CustomEvent('click')); }
    `);
    expect(edgeBetween(b, 'fire', 'onClick')?.synthesizedBy).toBe('event-channel');
  });

  it('ignores a keyless RxJS-style subscribe(fn) (no false edge)', async () => {
    const b = await build(`
      function onNext() { return 1; }
      function register(obs: any) { obs.subscribe(onNext); }
      function fire(obs: any) { obs.emit('whatever'); }
    `);
    // subscribe(fn) has no string key → no registration → no synthesized edge.
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('sets the dispatch-site line on the synthesized edge', async () => {
    const b = await build(`function onMount() { return 1; }
function register(e: any) { e.on('mount', onMount); }
function trigger(e: any) { e.emit('mount'); }`);
    const edge = edgeBetween(b, 'trigger', 'onMount');
    expect(typeof edge!.line).toBe('number');
    expect(edge!.line).toBeGreaterThan(0);
  });

  it('synthesized edges do NOT perturb fanIn/fanOut (structural metrics stay directly-resolved)', async () => {
    const b = await build(`
      function onMount() { return 1; }
      function register(e: any) { e.on('mount', onMount); }
      function trigger(e: any) { e.emit('mount'); }
    `);
    // The synthesized edge exists (reachability preserved)...
    expect(edgeBetween(b, 'trigger', 'onMount')?.confidence).toBe('synthesized');
    // ...but onMount has no DIRECT caller, so its fanIn stays 0 (synthesized excluded).
    const onMount = [...b.nodes.values()].find(n => n.name === 'onMount');
    expect(onMount?.fanIn).toBe(0);
  });

  it('Direct edges are unchanged by synthesis (only added edges differ)', async () => {
    const content = `
      function onMount() { return 1; }
      function helper() { return onMount(); }
      function register(e: any) { e.on('mount', onMount); }
      function trigger(e: any) { e.emit('mount'); }
    `;
    const b = await build(content);
    const directEdges = b.edges.filter(e => e.confidence !== 'synthesized');
    // Every directly-resolved edge is a real call-resolution edge (no synthesized leakage).
    expect(directEdges.every(e => e.synthesizedBy === undefined)).toBe(true);
    // The synthesis added at least one edge on top of the direct graph.
    expect(synthEdges(b).length).toBeGreaterThan(0);
    expect(b.edges.length).toBe(directEdges.length + synthEdges(b).length);
  });
});

describe('event-channel synthesis — Python', () => {
  const buildPy = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'app.py', content, language: 'Python' }]);

  it('Python event handler is reachable through a synthesized edge', async () => {
    const b = await buildPy([
      'def on_mount():',
      '    return 1',
      'def register(emitter):',
      "    emitter.on('mount', on_mount)",
      'def trigger(emitter):',
      "    emitter.emit('mount')",
    ].join('\n'));
    const edge = edgeBetween(b, 'trigger', 'on_mount');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('Python mismatched channel keys produce no edge', async () => {
    const b = await buildPy([
      'def handler():',
      '    return 1',
      'def register(e):',
      "    e.on('open', handler)",
      'def trigger(e):',
      "    e.emit('close')",
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'handler')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('resolves a Python self.method handler (attribute)', async () => {
    const b = await buildPy([
      'class C:',
      '    def on_mount(self):',
      '        return 1',
      '    def register(self, e):',
      "        e.on('mount', self.on_mount)",
      '    def trigger(self, e):',
      "        e.emit('mount')",
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'on_mount')?.synthesizedBy).toBe('event-channel');
  });

  it('wires a Python inline lambda handler to the functions its body calls', async () => {
    const b = await buildPy([
      'def real_handler():',
      '    return 1',
      'def register(e):',
      "    e.on('mount', lambda: real_handler())",
      'def trigger(e):',
      "    e.emit('mount')",
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'real_handler')?.synthesizedBy).toBe('event-channel');
  });

  it('supports Python pub/sub verbs (subscribe / publish)', async () => {
    const b = await buildPy([
      'def on_topic():',
      '    return 1',
      'def register(bus):',
      "    bus.subscribe('topic', on_topic)",
      'def fire(bus):',
      "    bus.publish('topic')",
    ].join('\n'));
    expect(edgeBetween(b, 'fire', 'on_topic')?.synthesizedBy).toBe('event-channel');
  });

  it('pairs on a Python constant member key (Events.MOUNT)', async () => {
    const b = await buildPy([
      'def on_mount():',
      '    return 1',
      'def register(e):',
      '    e.on(Events.MOUNT, on_mount)',
      'def trigger(e):',
      '    e.emit(Events.MOUNT)',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'on_mount')?.synthesizedBy).toBe('event-channel');
  });

  it('ignores a Python f-string (interpolated) key — no guess', async () => {
    const b = await buildPy([
      'def on_mount():',
      '    return 1',
      'def register(e, x):',
      "    e.on(f'mount-{x}', on_mount)",
      'def trigger(e, x):',
      "    e.emit(f'mount-{x}')",
    ].join('\n'));
    expect(synthEdges(b)).toHaveLength(0);
  });
});

describe('event-channel synthesis — Ruby', () => {
  const buildRb = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'app.rb', content, language: 'Ruby' }]);

  it('Ruby symbol-keyed on/emit with a block handler is reachable', async () => {
    const b = await buildRb([
      'def handler',
      '  do_work',
      'end',
      'def register(e)',
      '  e.on(:mount) { handler }',
      'end',
      'def trigger(e)',
      '  e.emit(:mount)',
      'end',
    ].join('\n'));
    const edge = edgeBetween(b, 'trigger', 'handler');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('Ruby mismatched symbol keys produce no edge', async () => {
    const b = await buildRb([
      'def handler',
      '  do_work',
      'end',
      'def register(e)',
      '  e.on(:open) { handler }',
      'end',
      'def trigger(e)',
      '  e.emit(:close)',
      'end',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'handler')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });

  it('Ruby ActiveSupport::Notifications subscribe/instrument (string key, block handler)', async () => {
    const b = await buildRb([
      'def handle_created',
      '  do_work',
      'end',
      'def register',
      "  ActiveSupport::Notifications.subscribe('user.created') { handle_created }",
      'end',
      'def trigger',
      "  ActiveSupport::Notifications.instrument('user.created') { save }",
      'end',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'handle_created')?.synthesizedBy).toBe('event-channel');
  });

  it('Ruby symbol key does not pair with a same-text string key', async () => {
    const b = await buildRb([
      'def handler',
      '  do_work',
      'end',
      'def register(e)',
      '  e.on(:mount) { handler }',
      'end',
      'def trigger(e)',
      "  e.emit('mount')",
      'end',
    ].join('\n'));
    // :mount (sym:) must not pair with 'mount' (str:).
    expect(edgeBetween(b, 'trigger', 'handler')).toBeUndefined();
  });
});

describe('event-channel synthesis — PHP', () => {
  const buildPhp = (content: string): Promise<Built> =>
    new CallGraphBuilder().build([{ path: 'app.php', content, language: 'PHP' }]);

  it('Laravel Event::listen with a string callable is reachable', async () => {
    const b = await buildPhp([
      '<?php',
      'function on_created() { do_work(); }',
      'function register() {',
      "  Event::listen('user.created', 'on_created');",
      '}',
      'function trigger() {',
      "  Event::dispatch('user.created');",
      '}',
    ].join('\n'));
    const edge = edgeBetween(b, 'trigger', 'on_created');
    expect(edge?.confidence).toBe('synthesized');
    expect(edge?.synthesizedBy).toBe('event-channel');
  });

  it('Laravel closure handler + event() helper dispatch', async () => {
    const b = await buildPhp([
      '<?php',
      'function on_updated() { do_work(); }',
      'function register() {',
      "  Event::listen('user.updated', function() { on_updated(); });",
      '}',
      'function trigger() {',
      "  event('user.updated');",
      '}',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'on_updated')?.synthesizedBy).toBe('event-channel');
  });

  it('Symfony addListener with a [$this, method] array callable', async () => {
    const b = await buildPhp([
      '<?php',
      'class C {',
      '  function on_x() { do_work(); }',
      '  function register($d) {',
      "    $d->addListener('x', [$this, 'on_x']);",
      '  }',
      '  function trigger($d) {',
      "    $d->dispatch('x');",
      '  }',
      '}',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'on_x')?.synthesizedBy).toBe('event-channel');
  });

  it('PHP mismatched keys produce no edge', async () => {
    const b = await buildPhp([
      '<?php',
      'function handler() { do_work(); }',
      'function register() {',
      "  Event::listen('open', 'handler');",
      '}',
      'function trigger() {',
      "  Event::dispatch('close');",
      '}',
    ].join('\n'));
    expect(edgeBetween(b, 'trigger', 'handler')).toBeUndefined();
    expect(synthEdges(b)).toHaveLength(0);
  });
});

describe('event-channel synthesis — per-language isolation', () => {
  it('does not pair a Python registration with a JS/TS dispatch on the same key', async () => {
    const b = await new CallGraphBuilder().build([
      { path: 'a.ts', content: [
        'function tsHandler() { return 1; }',
        "function tsReg(e: any) { e.on('shared', tsHandler); }",
        "function tsFire(e: any) { e.emit('shared'); }",
      ].join('\n'), language: 'TypeScript' },
      { path: 'a.py', content: [
        'def py_handler():',
        '    return 1',
        'def py_reg(e):',
        "    e.on('shared', py_handler)",
        'def py_fire(e):',
        "    e.emit('shared')",
      ].join('\n'), language: 'Python' },
    ]);
    // Within-language edges exist...
    expect(edgeBetween(b, 'tsFire', 'tsHandler')?.synthesizedBy).toBe('event-channel');
    expect(edgeBetween(b, 'py_fire', 'py_handler')?.synthesizedBy).toBe('event-channel');
    // ...but no cross-language pairing on the shared 'shared' key.
    expect(edgeBetween(b, 'tsFire', 'py_handler')).toBeUndefined();
    expect(edgeBetween(b, 'py_fire', 'tsHandler')).toBeUndefined();
  });
});

describe('route-handler synthesis (on-disk fixtures)', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-route-')); await mkdir(join(root, 'src'), { recursive: true }); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('Route is wired to its handler as a synthesized calls edge', async () => {
    const file = join(root, 'src', 'server.ts');
    const content = [
      'function listUsers(req, res) { res.send([]); }',
      'function setup(app) {',
      "  app.get('/users', listUsers);",
      '}',
    ].join('\n');
    await writeFile(file, content, 'utf-8');
    const b = await new CallGraphBuilder().build([{ path: file, content, language: 'TypeScript' }]);
    const setup = idByName(b, 'setup'), handler = idByName(b, 'listUsers');
    const edge = b.edges.find(e => e.callerId === setup && e.calleeId === handler && e.confidence === 'synthesized');
    expect(edge).toBeDefined();
    expect(edge!.synthesizedBy).toBe('route-handler');
    expect(edge!.kind).toBe('calls');
  });
});
