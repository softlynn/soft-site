import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';

// Exercise component state/effects without mounting external players or loading
// their remote assets. Host UI elements stay inspectable plain element records.
export const createComponentHarness = async (url, dependencies, globals = {}, onRender = () => {}) => {
  const slots = [];
  const timers = new Map();
  const intervals = new Map();
  let nextTimer = 1;
  let hook = 0;
  let dirty = false;
  let effects = [];
  let output;
  let props;
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const createElement = (type, props, ...children) => ({
    type, key: props?.key == null ? null : String(props.key),
    props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) },
  });
  const react = {
    createElement,
    lazy: () => 'LazyComponent',
    Suspense: 'Suspense',
    createRef: () => ({ current: null }),
    useRef(value) {
      const index = hook++;
      return slots[index] ??= { current: value };
    },
    useState(value) {
      const index = hook++;
      slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, (next) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(slots[index].value, value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useCallback(callback, deps) {
      const index = hook++;
      if (!equalDeps(slots[index]?.deps, deps)) slots[index] = { value: callback, deps };
      return slots[index].value;
    },
    useMemo(factory, deps) {
      const index = hook++;
      if (!equalDeps(slots[index]?.deps, deps)) slots[index] = { value: factory(), deps };
      return slots[index].value;
    },
    useEffect(callback, deps) {
      const index = hook++;
      if (!equalDeps(slots[index]?.deps, deps)) {
        const previous = slots[index];
        slots[index] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback(); });
      }
    },
  };
  const imports = {
    react: { default: react, ...react },
    ...dependencies,
  };
  const source = (await readFile(url, 'utf8'))
    .replace(/import\s+([^;]*?)\s+from\s+["']([^"']+)["'];?/g, (_, names, path) => {
      const statements = [];
      const named = names.match(/\{([^}]+)\}/)?.[1];
      if (named) statements.push(`const { ${named.replace(/\s+as\s+/g, ': ')} } = imports[${JSON.stringify(path)}];`);
      const defaultName = names.split(/[,{]/)[0].trim();
      if (defaultName) statements.push(`const ${defaultName} = imports[${JSON.stringify(path)}].default;`);
      return statements.join('\n');
    })
    .replace(/import\s+["'][^"']+["'];?/g, '')
    .replace('export default function ', 'function ');
  const componentName = (await readFile(url, 'utf8')).match(/export default function (\w+)/)[1];
  const transformed = await transformWithOxc(source, url.pathname, { lang: 'jsx', jsx: { runtime: 'classic' } });
  const component = runInNewContext(`${transformed.code}\n${componentName};`, {
    imports, React: react, console,
    document: { hidden: false },
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: fn => { const id = nextTimer++; intervals.set(id, fn); return id; },
    clearInterval: id => intervals.delete(id),
    ...globals,
  });
  const render = (nextProps = props) => {
    props = nextProps;
    for (let attempt = 0; attempt < 50; attempt++) {
      dirty = false; hook = 0; effects = [];
      output = component(props);
      onRender(output);
      for (const effect of effects) effect();
      if (!dirty) return output;
    }
    throw new Error('Component did not settle');
  };
  return {
    render,
    async settle() {
      for (let step = 0; step < 5; step++) {
        await new Promise(resolve => setImmediate(resolve));
        if (dirty) render();
      }
      return output;
    },
    async runTimers() {
      const pending = [...timers.values()]; timers.clear();
      for (const timer of pending) timer();
      return this.settle();
    },
    async runIntervals() {
      for (const interval of [...intervals.values()]) interval();
      return this.settle();
    },
    dispose() { for (const slot of slots) slot?.cleanup?.(); timers.clear(); intervals.clear(); },
  };
};

export const findElements = (tree, predicate) => {
  const matches = [];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object' || !node.props) return;
    if (predicate(node)) matches.push(node);
    visit(node.props.children);
  };
  visit(tree);
  return matches;
};

export const uiElements = new Proxy({ styled: () => () => 'StyledCollapse' }, {
  get: (target, name) => target[name] || String(name),
});
