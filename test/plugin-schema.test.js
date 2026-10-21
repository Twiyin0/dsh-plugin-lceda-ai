// Guards what actually reaches the model provider.
//
// ctx.tools.register() stores `parameters` verbatim (only defineTool, which a
// bundle cannot import, compiles the shorthand table), so the plugin must send a
// real object-rooted JSON Schema. These tests mirror the Harness' enforced
// subset (type/oneOf/properties/required/additionalProperties/items/enum/const
// plus description/title/default/examples) and the provider's object-root rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tools, compileParameters } from '../index.js';

const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATION = new Set(['description', 'title', 'default', 'examples']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function checkNode(node, path, violations) {
  assert.ok(node && typeof node === 'object' && !Array.isArray(node), `${path} must be a schema object`);
  for (const key of Object.keys(node)) {
    if (CONSTRAINT.has(key)) continue;
    assert.ok(ANNOTATION.has(key), `${path}.${key} is not in the supported subset`);
  }
  if (node.description !== undefined) assert.equal(typeof node.description, 'string', `${path}.description must be a string`);
  assert.ok(node.type !== undefined || node.oneOf !== undefined, `${path} needs type or oneOf`);
  if (node.type !== undefined) assert.ok(TYPES.has(node.type), `${path}.type ${node.type} unsupported`);
  if (node.enum !== undefined) assert.ok(Array.isArray(node.enum) && node.enum.every((v) => typeof v === 'string'), `${path}.enum must be strings`);
  if (node.items !== undefined) checkNode(node.items, `${path}.items`, violations);
  if (node.properties !== undefined) {
    const declared = new Set(Object.keys(node.properties));
    for (const [pname, prop] of Object.entries(node.properties)) checkNode(prop, `${path}.properties.${pname}`, violations);
    if (node.required !== undefined) {
      assert.ok(Array.isArray(node.required), `${path}.required must be an array`);
      for (const r of node.required) assert.ok(declared.has(r), `${path}.required names unknown property ${r}`);
    }
  }
}

test('every tool compiles to an object-rooted JSON Schema the provider accepts', () => {
  assert.ok(tools.length >= 7, `expected at least 7 tools, got ${tools.length}`);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `bad tool name ${tool.name}`);
    assert.ok(tool.description.length > 40, `${tool.name} description too short`);
    const schema = compileParameters(tool.parameters);
    assert.equal(schema.type, 'object', `${tool.name}: root type must be object`);
    assert.ok(Object.keys(schema.properties).length > 0, `${tool.name}: no properties`);
    checkNode(schema, tool.name, []);
    // the create tool regressed once with a parameter named "title"
    for (const key of Object.keys(schema.properties)) {
      assert.ok(!ANNOTATION.has(key), `${tool.name}: parameter "${key}" collides with a schema keyword`);
    }
  }
});

test('create tool exposes sheetTitle, not the reserved word title', () => {
  const create = tools.find((t) => t.name === 'lceda_create_schematic');
  assert.ok(create, 'create tool missing');
  const schema = compileParameters(create.parameters);
  assert.ok(schema.properties.sheetTitle, 'sheetTitle property missing');
  assert.ok(!('title' in schema.properties), 'reserved parameter name "title" must not be used');
  assert.deepEqual(schema.required, ['path']);
});

test('compileParameters rejects unsupported types', () => {
  assert.throws(() => compileParameters({ a: { type: 'date' } }), /unsupported type/);
  assert.throws(() => compileParameters({ a: { type: 'array', items: { type: 'blob' } } }), /unsupported items type/);
});
