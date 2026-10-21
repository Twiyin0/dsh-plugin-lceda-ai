// Guards the tool schemas the Harness turns into function definitions: a
// parameter named after a JSON Schema keyword (e.g. "title") invalidates the
// whole function schema and the tool refuses to load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tools } from '../index.js';

const RESERVED = new Set([
  'title', 'description', 'default', 'type', 'enum', 'properties', 'required', 'items',
  'format', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems',
  'maxItems', 'uniqueItems', 'additionalProperties', '$ref', 'definitions', 'examples',
  'oneOf', 'anyOf', 'allOf', 'not', 'const', 'multipleOf', 'exclusiveMinimum',
  'exclusiveMaximum', 'minProperties', 'maxProperties',
]);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

test('every tool registers a valid function schema', () => {
  assert.ok(tools.length >= 7, `expected at least 7 tools, got ${tools.length}`);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `bad tool name ${tool.name}`);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 40, `${tool.name} description too short`);
    assert.equal(typeof tool.parameters, 'object', `${tool.name} has no parameters`);

    for (const [key, spec] of Object.entries(tool.parameters)) {
      assert.ok(!RESERVED.has(key), `${tool.name}: parameter "${key}" is a reserved JSON Schema keyword`);
      const type = typeof spec === 'string' ? spec : spec?.type;
      assert.ok(TYPES.has(type), `${tool.name}.${key}: unsupported type ${type}`);
      if (spec && typeof spec === 'object') {
        if (spec.enum) assert.ok(spec.enum.every((v) => typeof v === 'string'), `${tool.name}.${key}: enum must be strings`);
        if (spec.items) assert.ok(TYPES.has(spec.items.type), `${tool.name}.${key}: bad items type`);
        if ('required' in spec) assert.equal(typeof spec.required, 'boolean', `${tool.name}.${key}: inline required must be a boolean`);
      }
    }
    assert.equal(typeof tool.execute, 'function', `${tool.name} has no execute`);
  }
});

test('create tool exposes sheetTitle (not the reserved word title)', () => {
  const create = tools.find((t) => t.name === 'lceda_create_schematic');
  assert.ok(create, 'create tool missing');
  assert.ok(create.parameters.sheetTitle, 'sheetTitle parameter missing');
  assert.ok(!('title' in create.parameters), 'reserved parameter name "title" must not be used');
});
