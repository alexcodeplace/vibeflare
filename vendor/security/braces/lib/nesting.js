"use strict";

// Bounded iterative validation protects every public recursive AST walker.
// Parent/prev pointers are intentionally not traversed: they are AST metadata.
const MAX_DEPTH = 128;
const MAX_NODES = 100000;
const fail = () => { throw new SyntaxError('Brace AST nesting limit exceeded'); };
function assertNesting(root) {
  const active = new WeakSet();
  const stack = [{ node: root, depth: 0, leave: false }];
  let visited = 0;
  while (stack.length) {
    const frame = stack.pop();
    const node = frame.node;
    if (!node || typeof node !== 'object') throw new TypeError('Expected a brace AST node');
    if (frame.leave) { active.delete(node); continue; }
    if (frame.depth > MAX_DEPTH || ++visited > MAX_NODES || active.has(node)) fail();
    if (!Array.isArray(node.nodes)) continue;
    if (node.nodes.length > MAX_NODES - visited) fail();
    active.add(node);
    stack.push({ node, depth: frame.depth, leave: true });
    for (let i = node.nodes.length - 1; i >= 0; i--) {
      stack.push({ node: node.nodes[i], depth: frame.depth + 1, leave: false });
    }
  }
}
module.exports = { MAX_DEPTH, assertNesting, fail };
